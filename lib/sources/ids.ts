// Offset-band Transfer.id namespaces for HiveSQL-sourced transfers
// (HIVESQL-HA-PLAN.md §5).
//
// Spokes do BigInt(transfer.id) into a bigint PK (Phase 0 finding), so ids
// must be unique DECIMAL NUMERIC strings that fit int8. HAF op ids
// (~4.6e17 today) own the low range; HiveSQL rows get bands far above them:
//
//   HBD  band: 2^62         + TxTransfers.ID   ≈ 4.61e18 + <2^31
//   HE   band: 2^62 + 2^61  + TxCustoms.ID     ≈ 6.92e18 + <~2^33
//
// HAF ids reach 2^62 only at block ~1.07e9 (~90 years away); both bands stay
// below int8 max (2^63 - 1 ≈ 9.22e18) and cannot collide with each other.

export const HIVESQL_HBD_ID_OFFSET = BigInt('4611686018427387904');  // 2^62
export const HIVESQL_HE_ID_OFFSET = BigInt('6917529027641081856');   // 2^62 + 2^61
const BAND_WIDTH = BigInt('2305843009213693952');                     // 2^61

function bandId(offset: bigint, sourceRowId: bigint | number): string {
  const rowId = BigInt(sourceRowId);
  // A source row id escaping its 2^61-wide band means the namespace
  // assumption broke (HBD would bleed into the HE band; HE past int8 max) —
  // refuse to emit a colliding/overflowing id.
  if (rowId < BigInt(0) || rowId >= BAND_WIDTH) {
    throw new Error(`HiveSQL row id ${sourceRowId} out of band range`);
  }
  return (offset + rowId).toString();
}

/** Transfer.id for a HiveSQL TxTransfers row. */
export function hivesqlHbdTransferId(txTransfersId: bigint | number): string {
  return bandId(HIVESQL_HBD_ID_OFFSET, txTransfersId);
}

/** Transfer.id for a HiveSQL TxCustoms row. */
export function hivesqlHeTransferId(txCustomsId: bigint | number | string): string {
  // TxCustoms.ID is bigint on the wire — mssql delivers it as a string
  return bandId(HIVESQL_HE_ID_OFFSET, typeof txCustomsId === 'string' ? BigInt(txCustomsId) : txCustomsId);
}
