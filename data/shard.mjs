// 사업 상세 파일 묶음 번호 (앱·내보내기 공용). id → '00'~'3f'
export const SHARDS = 64;
export function shardOf(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return (h % SHARDS).toString(16).padStart(2, '0');
}
