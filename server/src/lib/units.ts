// Car seat manuals in the US give limits in pounds and inches; we store
// kilograms and centimetres and convert at the edges.

export const LB_PER_KG = 2.204_622_6;
export const CM_PER_IN = 2.54;

export type WeightUnit = "kg" | "lb";
export type LengthUnit = "cm" | "in";

export function toKg(value: number, unit: WeightUnit = "kg"): number {
  return unit === "lb" ? value / LB_PER_KG : value;
}

export function toCm(value: number, unit: LengthUnit = "cm"): number {
  return unit === "in" ? value * CM_PER_IN : value;
}

export function round(value: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** "18 kg (39.7 lb)" */
export function showKg(kg: number): string {
  return `${round(kg, 1)} kg (${round(kg * LB_PER_KG, 1)} lb)`;
}

/** "102 cm (40.2 in)" */
export function showCm(cm: number): string {
  return `${round(cm, 1)} cm (${round(cm / CM_PER_IN, 1)} in)`;
}
