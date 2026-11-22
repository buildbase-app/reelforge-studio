# BuildBase console: screens to capture by hand

The capture pipeline cannot sign in to the BuildBase console (no agent signs in
as the founder), so the console's configuration is published as code instead:
[docs/public/install/buildbase-console-setup.md](public/install/buildbase-console-setup.md),
regenerated with `pnpm capture --only console` (docs/CAPTURE.md). If a picture
of a console screen is still wanted, these are the screens, in the
**development** environment first (environment switcher at the top of the
console: `development`), then the same screens in **Production**.

Before each screenshot: hide or crop anything personal (your email in the
top-right menu, buyer emails in Orders), never show a secret (Stripe keys,
webhook signing secrets, client secrets are behind "Reveal" buttons: leave them
hidden), and use the browser at 1440 px wide.

| # | Screen | Menu path in the console | What the screenshot shows |
| --- | --- | --- | --- |
| 1 | Sign-in methods | **Users** > **Authentication**, tab **Settings** | Email and password, magic link and passkeys switched on |
| 2 | Sign-in client | **Users** > **Authentication**, the `development` client | Redirect URLs, token and profile URLs (client secret hidden) |
| 3 | Hosted sign-in page | **Users** > **Authentication**, page and security settings | Session length, two-factor optional, sign-up open |
| 4 | Stripe credentials | **Billing** > **Credentials** | Test keys saved (values masked), webhook configuration |
| 5 | Selling overview | **Billing** > **Selling**, tab **Overview** | The checklist and "Before going live" list |
| 6 | Own store | **Billing** > **Selling**, tab **Settings** | Own store on, shown as "ReelForge"; terms and refund policy links |
| 7 | Items | **Billing** > **Selling**, tab **Items** | ReelForge Personal (free) and ReelForge Commercial (Solo, Studio, Agency) published |
| 8 | Item type | **Billing** > **Item types**, `reelforge-licence` | Fixed or free prices, licence keys, files, up to 4 variants |
| 9 | Orders | **Billing** > **Selling**, tab **Orders** | Test orders paid (crop buyer emails) |
| 10 | Webhooks | **Settings** > **Webhooks** | The store endpoint `…/api/webhooks/buildbase`, all events, enabled |
| 11 | Docs | **Content** > **Docs** | The folders and pages published from the repository |
| 12 | Blogs | **Content** > **Blogs** | Published posts |
| 13 | Collections | **Content** > **Collections** (under **Data**) | The `gallery` collection and its fields |
| 14 | Assets | **Content** > **Assets** (under **Media & links**) | The `rf-capture--…` screenshots uploaded by `pnpm capture --upload` |
| 15 | Email senders | **Messaging** > **Sender accounts** | The default sender (system default) |
| 16 | Environments | **Settings** > **General** | The `development` environment and its key |

Save them as `console-<number>-<screen>.png`; they can be uploaded to BuildBase
Assets with the rest (name them `rf-capture--console--<screen>--<hash8>.png` or
add them to the capture manifest by hand) and linked from the console setup
page.
