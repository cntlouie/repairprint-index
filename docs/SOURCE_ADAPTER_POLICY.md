# Source adapter policy record

Reviewed 2026-07-13 for WP-10. This engineering record does not grant legal
permission. A reviewer-attributed database policy review is still required
before any adapter request, and automated checks can never renew that review.

## Current decisions

| Platform | Primary official source checked | WP-10 decision | Automation state |
| --- | --- | --- | --- |
| Thingiverse | [Developer portal](https://www.thingiverse.com/developers) and [API terms](https://www.thingiverse.com/legal/api) | The project has no recorded application credential or written approval for the intended fields and use. The repository therefore ships only a fictional fixture implementation. | Disabled outside tests/demo fixtures |
| Printables | [Printables terms](https://www.prusa3d.com/page/terms-of-service-of-printables-com_231249/) | No reviewed official API permission for this project is recorded. Accept staff-entered or creator-submitted landing-page facts only. | Manual/creator submission only |
| MakerWorld | [User agreement](https://makerworld.com/en/user-agreement) | No reviewed written automation permission is recorded. | Blocked |
| iFixit | [Licensing](https://www.ifixit.com/Info/Licensing) | The published licensing page describes non-commercial reuse terms; no separate commercial automation permission for RepairPrint is recorded. | Manual citation only |

The field boundary is deliberately narrower than any platform response:
external item ID, original landing-page URL, title, creator display name,
licence state and immutable source revision only when the current reviewed
policy explicitly lists each field. Full descriptions, design files and
repository images are forbidden.

## Review and freshness contract

- Missing, blocked, disabled, automation-forbidden, commercially incompatible
  or stale policy evidence fails before an adapter calls the network.
- The maximum review lifetime is 366 days and may be shorter. Both the current
  policy row and the immutable review snapshot must agree.
- A reviewer/admin records the official URL, checksum, checked time, expiry,
  exact allowed fields, evidence and reason. The database makes the snapshot
  append-only and writes an immutable audit event.
- A terms/link checker may report change or expiry, but cannot extend approval.
- `SOURCE_ADAPTER_MODE=fixture` is accepted only in test or with
  `DEMO_MODE=true`. No production/live adapter mode exists in WP-10.

## Supported citation dependency map

Confirmed source removal, restriction or material redirect moves published
fitments to `needs_review` when the source is attached to:

- the fitment's exact `design_revision` (including its primary `source_id`);
- `fitment_evidence` or `print_recipe` for that exact fitment;
- the exact `product_component`, `product_model`, primary
  `product_identifier`, editorial `component`, or `oem_part` used by the
  fitment.

No other polymorphic `source_citations.entity_type` is inferred. Adding one
requires an explicit migration, dependency query and removal regression test.
