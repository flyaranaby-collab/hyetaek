// 행정안전부 「대한민국 공공서비스(혜택) 정보」 오픈API 클라이언트
// 문서: https://www.data.go.kr/data/15113968/openapi.do
// 오퍼레이션: /gov24/v3/serviceList, /gov24/v3/serviceDetail, /gov24/v3/supportConditions

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Gov24Error extends Error {
  constructor(msg, { status, retryable } = {}) { super(msg); this.status = status; this.retryable = retryable; }
}

export class Gov24Client {
  constructor({ base, apiKey, timeoutMs = 20000, retries = 3, perPage = 500, fetchImpl = fetch, delayMs = 150 }) {
    if (!apiKey) throw new Gov24Error('DATA_GO_KR_KEY(공공데이터포털 인증키)가 설정되지 않았습니다.');
    Object.assign(this, { base, apiKey, timeoutMs, retries, perPage, fetchImpl, delayMs });
  }

  async call(path, params = {}) {
    const url = new URL(this.base + path);
    url.searchParams.set('serviceKey', this.apiKey);
    url.searchParams.set('returnType', 'JSON');
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await sleep(Math.min(8000, 500 * 2 ** attempt));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
        const text = await res.text();
        if (res.status === 401 || res.status === 403) throw new Gov24Error(`인증 실패(${res.status}) — 인증키·활용신청 상태를 확인하세요`, { status: res.status, retryable: false });
        if (res.status === 429 || res.status >= 500) throw new Gov24Error(`일시 오류(${res.status})`, { status: res.status, retryable: true });
        if (!res.ok) throw new Gov24Error(`요청 오류(${res.status}): ${text.slice(0, 200)}`, { status: res.status, retryable: false });
        let json;
        try { json = JSON.parse(text); }
        catch { throw new Gov24Error(`JSON 아님: ${text.slice(0, 200)}`, { retryable: /SERVICE_KEY|LIMITED/.test(text) ? false : true }); }
        return json;
      } catch (err) {
        lastErr = err.name === 'AbortError' ? new Gov24Error('응답 시간 초과', { retryable: true }) : err;
        if (lastErr instanceof Gov24Error && lastErr.retryable === false) throw lastErr;
      } finally { clearTimeout(timer); }
    }
    throw lastErr;
  }

  /** 페이지를 끝까지 넘기며 모든 행을 모은다 */
  async *paginate(path, params = {}) {
    let page = 1, seen = 0;
    while (true) {
      const j = await this.call(path, { ...params, page, perPage: this.perPage });
      const rows = Array.isArray(j.data) ? j.data : [];
      for (const r of rows) yield r;
      seen += rows.length;
      const total = +j.totalCount || 0;
      if (!rows.length || seen >= total) break;
      page++;
      if (this.delayMs) await sleep(this.delayMs);
    }
  }

  serviceList({ modifiedSince } = {}) {
    return this.paginate('/gov24/v3/serviceList', modifiedSince ? { 'cond[수정일시::GTE]': modifiedSince } : {});
  }
  /** 상세는 문서상 필터 파라미터가 없어 전체를 페이지로 받는다 (약 수십 회 호출) */
  serviceDetail() { return this.paginate('/gov24/v3/serviceDetail'); }
  async supportConditions(serviceId) {
    const j = await this.call('/gov24/v3/supportConditions', { 'cond[서비스ID::EQ]': serviceId, page: 1, perPage: 1 });
    return Array.isArray(j.data) && j.data[0] ? j.data[0] : null;
  }
  /** 조건 전체를 한 번에 (서비스별 호출보다 호출 수가 훨씬 적음) */
  supportConditionsAll() { return this.paginate('/gov24/v3/supportConditions'); }
}
