// utils/number.utils.ts
export const roundTo2 = (num: number): number => {
  return Math.round(num * 100) / 100;
};

export const roundObjectNumbers = (obj: Record<string, any>): Record<string, any> => {
  const rounded: Record<string, any> = {};
  for (const key in obj) {
    const val = obj[key];
    if (typeof val === 'number') {
      rounded[key] = roundTo2(val);
    } else {
      rounded[key] = val;
    }
  }
  return rounded;
};