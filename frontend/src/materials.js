// A T&M material's preview line (2026-11-20): the ticket's quantity × the unit
// price the PM types, or the typed figure itself as a lump sum when the ticket
// has no quantity. Rounded like the worker (computeMaterialLines).
export function materialLineAmount(line) {
  const unit = Number(line?.unitCost) || 0;
  const amount = line?.quantity != null ? Number(line.quantity) * unit : unit;
  return Math.round(amount * 100) / 100;
}
