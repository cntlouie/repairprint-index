# Legal, source-rights, and platform guardrails

**Status:** operating draft as of 2026-07-11. This is not legal advice. Before public launch, have qualified counsel review the Iceland/EU service classification, contributor terms/privacy language, safety claims/disclaimers, and notice process.

## The safest useful v0 boundary

Operate RepairPrint Index as a curated editorial fitment index:

- Link to the original creator’s public landing page, not a raw download URL.
- Do not host, proxy, cache, convert, remix, or serve STL/3MF/G-code files.
- Do not hotlink repository thumbnails.
- Use RepairPrint-owned imagery or contributor media with an explicit separate display licence.
- Cite manufacturer manuals/catalogues and extract independently checked facts; do not republish diagrams, pages, or copied descriptions.
- Do not add checkout, paid downloads, print-on-demand, or a marketplace in v0.
- Describe “Verified fit” as fit evidence only—not safe, certified, load-rated, OEM-equivalent, or manufacturer-endorsed.

This boundary reduces exposure; it does not remove ordinary copyright, privacy, consumer-protection, negligence, or misleading-claim risk.

## Linking versus copying

For every outbound design source, require:

- Original repository landing page
- Identifiable creator
- Visible licence or permission state
- Reasonable confirmation it is an original upload, not an unauthorized mirror
- `rights_checked_at` and reviewer
- Immediate hold when a creator/rightsholder submits a credible dispute

Do not bypass access controls. A monetized linking service should treat notices seriously and promptly remove/hold links reasonably believed unlawful. Relevant EU authority includes the [GS Media judgment](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A62015CJ0160).

Copying a design, photo, diagram, or description invokes reproduction/display questions. Embedding can also create risk when it circumvents restrictions. See the [EU InfoSoc Directive](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A32001L0029) and [VG Bild-Kunst judgment](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A62019CJ0392).

Systematically reconstructing another database can implicate database rights even through repeated extraction of small portions; see [Database Directive Article 7](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A31996L0009).

## Creative Commons data model

Store structured rights state separately for the design file, source thumbnail, RepairPrint text, and contributor photo:

```text
license_code / version / jurisdiction / URL
license_evidence_url / checked_at
creator_name / profile URL
source_title / source URL
attribution_text
commercial_use_allowed
derivatives_allowed
share_alike_required
permission_document_id
```

Practical policy for a monetized site:

| Licence/state | V0 policy |
| --- | --- |
| CC0 | Link; hosting still deferred. Confirm uploader rights before later reuse. |
| CC BY | Link; later reuse requires complete attribution. |
| CC BY-SA | Link; later adaptations must observe share-alike. |
| CC BY-ND | Link; do not convert/modify without separate review. |
| Any CC-NC | Link only unless separate commercial permission is documented. |
| All Rights Reserved / unknown / custom | Link only. |
| Creator written permission | Use only within the documented scope. |

Creative Commons explains the conditions and six licence types in its [official licence guide](https://creativecommons.org/cc-licenses/). Preserve title, author, source, licence, and modification disclosure where reuse occurs. A file licence does not automatically cover photographs.

`NOT-STATED` records an observed absence of an explicit licence. It is never permission to copy, sell, or remix.

## Source platform policy

Terms change. Check and timestamp them before implementing an adapter, and disable automation when the check expires.

| Source | Initial v0 rule | Primary reference |
| --- | --- | --- |
| Thingiverse | Official registered API only, within its API agreement; minimal metadata and landing-page links | [Developer portal](https://www.thingiverse.com/developers), [API agreement](https://www.thingiverse.com/legal/api) |
| Printables | Creator/manual link submission or written permission; no automated/systematic extraction by default | [Prusa website terms](https://www.prusa3d.com/page/general-terms-and-conditions-of-use-of-the-prusa-websites_231226/), [Printables terms](https://www.prusa3d.com/page/terms-of-service-of-printables-com_231249/) |
| MakerWorld | Block automated ingestion until written permission | [MakerWorld terms](https://makerworld.com/en/user-agreement) |
| iFixit | Outbound links/taxonomy only unless commercial rights are obtained | [Licensing](https://www.ifixit.com/Info/Licensing), [API](https://www.ifixit.com/api-docs) |
| Open Repair Alliance | Demand/category analysis under dataset terms; not fitment proof | [Open data](https://openrepair.org/open-data/downloads/) |

Do not interpret an available API as blanket permission to reuse all API content commercially. The source-policy record controls allowed fields, images, files, automation, and commercial use.

## Product safety and liability

EU general product-safety assessment considers design/composition, interaction, warnings, foreseeable use/users, and vulnerable users. See [GPSR Articles 5–8](https://eur-lex.europa.eu/eli/reg/2023/988/oj).

RepairPrint v0 should remain an editorial link index and exclude any part whose failure could plausibly cause injury, fire, shock, gas/pressure release, vehicle control loss, guard failure, collapse, or life-safety harm.

The new EU Product Liability Directive expressly includes digital manufacturing files used by automated machinery such as 3D printers in its product framework. Member States are to apply implementing measures to products placed on the market/made available after 9 December 2026. Hosting, creating, materially modifying, branding, or selling files can therefore create a materially different risk profile from editorial linking. See [Directive (EU) 2024/2853](https://eur-lex.europa.eu/eli/dir/2024/2853/oj/eng).

If RepairPrint later becomes an online marketplace, the GPSR includes marketplace duties around product-safety contacts, Safety Gate cooperation, trader/product information, notices, removals, and recalls. Treat marketplace/checkout as a separate product and legal project; see [GPSR Article 22](https://eur-lex.europa.eu/eli/reg/2023/988/oj).

## User submissions, privacy, and DSA

V0 rules:

- No automatically public submissions, comments, profiles, or user file pages.
- Submissions remain private until editors create a canonical record.
- Contributor confirms ownership/permission for submitted text and images.
- Contributor grant covers only the specific storage, moderation, derivative thumbnail, and approved publication purposes written in the terms.
- Strip EXIF and redact serial numbers, addresses, faces, receipts, and unnecessary personal data.
- Publish a retention schedule and delete rejected/expired media accordingly.
- Provide one visible rights/illegal-content/safety notice channel.

The EU Digital Services Act includes core notice-and-action requirements for hosting services and broader duties for online platforms. See [DSA Articles 6 and 16–19](https://eur-lex.europa.eu/eli/reg/2022/2065/oj). Editorial pre-moderation may reduce exposure but does not by itself settle legal classification.

As of 2026-07-11, EFTA’s tracker listed the DSA under scrutiny for EEA incorporation rather than incorporated into the EEA Agreement. However, the DSA can cover a non-EU provider that offers services to EU recipients with a substantial EU connection; mere technical accessibility alone is not enough. See the [EFTA status page](https://www.efta.int/eea-lex/32022r2065) and DSA territorial/representative provisions. Counsel should decide whether/how RepairPrint targets EU users and whether a representative is required.

## Trademarks and brand presentation

Use brand/model word marks only as necessary to identify compatibility, in plain text and honest commercial practice. Avoid brand logos and trade dress. Display an independent-site statement such as:

> RepairPrint Index is independent and is not affiliated with or endorsed by the product manufacturers listed.

EU trade mark law includes limits permitting necessary referential use under honest practices; see [EU Trade Mark Regulation Article 14](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A32017R1001).

## Required prelaunch legal decisions

1. Final Iceland/EU DSA classification and territorial targeting
2. Contributor licence, consent, privacy notice, and retention wording
3. Fitment/safety disclaimer and claims style
4. Notice, takedown, correction, appeal, and emergency safety process
5. Trademark/independence wording
6. Affiliate disclosure and consumer-law presentation

Record the advice date and revisit after adding hosting, public UGC, accounts, commerce, print services, or safety classes beyond low risk.
