// 영문 축약형 공백 교정 (PC Core/TextNormalizer.cs 이식, dc5e804·9bf98d4).
// BMS #TITLE/#ARTIST나 info.txt 문자열에 생기기 쉬운 "you'  re", "don ' t", "it ’ s"를 "you're", "don't", "it's"로 붙인다.
// 따옴표 변형(’ ＇ ` ´)도 표준 '로 바꾼다. 대소문자는 원문 그대로 둔다(DON ' T → DON'T).

const APOSTROPHES = /['’＇`´]/;
const NEGATIVE = /\b([A-Za-z]+?n)\s*['’＇`´]\s*(t)\b/gi;
const SUFFIX = /\b([A-Za-z]+)\s*['’＇`´]\s*(re|ve|ll|d|m|s)\b/gi;

export function normalizeEnglishContractions(text: string): string;
export function normalizeEnglishContractions(text: string | null | undefined): string | null | undefined;
export function normalizeEnglishContractions(text: string | null | undefined): string | null | undefined {
    // 따옴표가 없으면 정규식을 건너뛴다(BMS 메타데이터 수백 줄을 파싱할 때 대부분 여기서 끝남).
    if (!text || !APOSTROPHES.test(text)) return text;
    return text.replace(NEGATIVE, "$1'$2").replace(SUFFIX, "$1'$2");
}
