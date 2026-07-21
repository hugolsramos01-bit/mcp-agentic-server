import { trim, clamp } from '../utils';
export function Widget(v: string, n: number) { return trim(v) + clamp(n, 0, 100); }
