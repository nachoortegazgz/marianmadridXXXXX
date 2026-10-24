# CMS Staff Map Contract

## Purpose

Keep a stable CMS relationship between each catalogued Wix Bookings service and the staff profiles that Wix Bookings assigns to that service.

## Canonical sources

- **Wix Bookings** is authoritative for staff profiles, assigned staff resources, working hours, booking policies, and live availability.
- **MapaStaff** maps a staff resource ID to the corresponding Wix Bookings staff-member ID and display name.
- **ServiciosCatalogo.staffMembers** is the CMS multi-reference used to associate a catalogued service with the staff map. It mirrors the staff assignments configured in Bookings; it does not calculate or replace live availability.

Do not use this CMS relationship as proof that a staff member is available at a particular date/time. The booking flow must query Wix Bookings and revalidate the exact slot before creating a booking.

## MapaStaff collection

| Field key | Type | Meaning |
|---|---|---|
| `resourceId` | TEXT | Canonical native Bookings resource ID; key used to join availability and staff identity |
| `memberId` | TEXT | Canonical Wix Site Member ID used to authorize the employee's authenticated session |
| `rolBookings` | TEXT | Native Bookings role; expected value for staff resources is `STAFF` |
| `rolWebsite` | TEXT | Canonical business authorization role: `ADMIN`, `GESTION`, or `ESTILISTA` |
| `staffName` | TEXT | Canonical display name used by the business backend |
| `thirdPartyId` | TEXT | Optional foreign key to `DatosFiscales`; must remain empty until formally linked |
| `scheduleId` | TEXT | Native Bookings schedule identifier used by booking creation |
| `wixStaffMemberId` | TEXT | Transitional native Bookings staff profile ID; retain until runtime migration is deployed and verified |
| `active` | BOOLEAN | Transitional field; current authorization is fail-closed on canonical row/role rather than trusting this flag |
| `sortOrder` | NUMBER | Transitional display-order field; do not remove until consumers are verified |

Permissions: reads and writes must follow the production CMS security contract; access to staff identity and business roles must not be exposed to anonymous clients. Do not add contact email, phone, member credentials, or other unnecessary personal data.

## ServiciosCatalogo relationship

| Field key | Type | Target |
|---|---|---|
| `staffMembers` | MULTI_REFERENCE | `MapaStaff` |

The reciprocal Wix-generated field is `MapaStaff.ServiciosCatalogo_staffMembers`.

The CMS field key is a technical contract. Do not rename it to match a visible label. The display label is **Personal disponible**.

## Live verification baseline — 2026-10-20

- `MapaStaff`: 3 active staff mappings.
- Wix Bookings: 94 appointment services.
- `ServiciosCatalogo`: 94 service records linked to native Bookings services, plus one separate pricing-plan catalog entry.
- All 94 appointment services have the three staff resources assigned in Wix Bookings.
- All 94 matching `ServiciosCatalogo` service records have exactly three valid references in `staffMembers`.
- The missing catalog record for the native **Rayos V** appointment was added using values read from Bookings (native service ID, title, slug, description, category, price EUR 20, and duration 20 minutes). No tax rate or cost basis was invented.

## Integration invariants

1. Match a catalog item to Bookings only by `serviceId`; never by title or slug.
2. Match a staff map by native `resourceId` and retain `wixStaffMemberId` separately.
3. The catalog relationship mirrors staff eligibility/assignment, not real-time calendar availability.
4. If a Bookings service or staff resource has no CMS mapping, report the mismatch; do not invent IDs or silently fall back to another person.
5. When native Bookings staff assignments change, update the CMS references through an idempotent synchronization process and verify the result.
6. Keep pricing, duration, booking policy, and actual availability authoritative in their native systems; CMS values are presentation/configuration data only.
7. Do not link the separate pricing-plan record as if it were an appointment service; it has no native `serviceId`.

## Verification procedure

Query `ServiciosCatalogo` with `includeReferences: [{ field: "staffMembers", limit: 10 }]`; query `MapaStaff`; query native Bookings services; compare by `serviceId` and `resourceId`. A passing reconciliation requires 94/94 native appointment services mapped, three valid staff references per service, and zero unresolved references.
