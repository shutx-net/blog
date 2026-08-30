// 3.9 で本物の配線に差し替える。ここでは build スクリプトを赤 -> 緑にするためのスタブ。
export const handler = async (): Promise<{ statusCode: number; body: string }> => ({
  statusCode: 501,
  body: '',
});
