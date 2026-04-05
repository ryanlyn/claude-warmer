export interface ColumnLayout {
  statusW: number;
  idW: number;
  showDir: boolean;
  dirW: number;
  nameW: number;
  showModel: boolean;
  modelW: number;
  cachedW: number;
  numW: number;
  showExpiry: boolean;
  warmsW: number;
  nextW: number;
}

/**
 * Compute column widths based on terminal width.
 * Progressively hides less important columns as width shrinks:
 *   >= 120: all columns
 *   >= 100: hide Model
 *   >= 80:  hide Model + Expiry
 *   < 80:  hide Model + Expiry + Dir
 */
export function computeLayout(cols: number): ColumnLayout {
  const selectW = 2;
  const statusW = 7;
  const idW = 9;
  const dirW = 12;
  const modelW = 10;
  const cachedW = 13;
  const numW = 8;
  const warmsW = 6;
  const nextW = 6;

  const showModel = cols >= 120;
  const showExpiry = cols >= 100;
  const showDir = cols >= 80;

  const fixed = selectW + statusW + idW
    + (showDir ? dirW : 0)
    + (showModel ? modelW : 0)
    + cachedW
    + (showExpiry ? numW : 0)
    + numW  // warm cost
    + warmsW + nextW;

  const nameW = Math.max(10, cols - fixed);

  return { statusW, idW, showDir, dirW, nameW, showModel, modelW, cachedW, numW, showExpiry, warmsW, nextW };
}
