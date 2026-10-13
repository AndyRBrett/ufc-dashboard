# Picked Fight for iOS (App Store build)

A [Capacitor](https://capacitorjs.com) shell around the live web app. It loads
`https://andyrbrett.github.io/ufc-dashboard/` in a native web view and adds
what a web page can't do inside an iOS app, starting with **native push**
(Web Push doesn't run in an app's web view).

Nothing here changes the web app for anyone using it in a browser: every
native code path in `index.html` (`// native:start … :end`) checks
`_nativeApp()` first, which is false outside this shell.

## How it fits together

| piece | where | what it does |
| ----- | ----- | ------------ |
| the shell | `native/` (this folder) | Xcode project, Capacitor config, offline fallback page |
| push registration | `index.html` native block | asks iOS for permission, gets an APNs device token, registers it with `send-push` (`type: "register", platform: "ios"`) |
| device tokens | `apns_devices` (`supabase/migrations/0022_apns_devices.sql`) | one row per phone, keyed on the token; deleted with the account |
| delivery | `send-push` + `supabase/functions/_shared/apns.js` | every push goes to the web subscribers **and** the iPhones, by the same audience, blocks and per-kind switches |
| filtered roast | `ai-breakdown` (`roastFiltered`) | the app sends `store: true`, so its roasts are Claude's, without the unfiltered Grok rule (Apple 1.1 / 1.2) |

The app loads the live site (`server.url`) rather than a bundled copy, so it
is always the current release, the service worker and `data.js` work as
they do on the web, and the Supabase origin check (`ALLOWED_ORIGINS`) needs
no change. `WKAppBoundDomains` (Info.plist) + `limitsNavigationsToAppBoundDomains`
is what lets the service worker run inside the web view. A bundled build
(`capacitor://localhost`) would need the `data.js` → `data.json` move first
(`docs/MODERNIZATION.md` item 3) and `capacitor://localhost` added to
`ALLOWED_ORIGINS`.

## What only you can do (one-time)

1. **Apple Developer Program** ($99/yr) at developer.apple.com, as an
   individual or an organisation.
2. **Register the bundle id** `com.andyrbrett.pickedfight` (Certificates, IDs &
   Profiles → Identifiers), with the **Push Notifications** capability ticked.
   To use a different id, change `appId` in `capacitor.config.json` and
   `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project, and use it as `APNS_TOPIC`.
3. **Create an APNs key** (Keys → +, Apple Push Notifications service). Download
   the `.p8` once (Apple won't show it again) and note its Key ID and your Team ID.
4. **Set the Supabase function secrets** (Dashboard → Edge Functions → Secrets):

   | secret | value |
   | ------ | ----- |
   | `APNS_KEY` | the whole `.p8` file, including the `-----BEGIN PRIVATE KEY-----` lines |
   | `APNS_KEY_ID` | the key's 10-character id |
   | `APNS_TEAM_ID` | your team id |
   | `APNS_TOPIC` | the bundle id |

   Until all four are set, `send-push` never touches `apns_devices`: web push
   carries on exactly as before.
5. **Apply `0022_apns_devices.sql`** in the SQL editor, re-run
   `0014_delete_account.sql` (it now lists `apns_devices`; it is re-runnable),
   then run the check query in `CLAUDE.md`. Deploy `send-push` and
   `ai-breakdown` (the deploy workflow does this on merge).
6. **App Store Connect**: create the app record (name, bundle id, SKU), the
   privacy "nutrition label" from `privacy.html`, age rating (expect 17+),
   support URL `support.html`, privacy URL `privacy.html`.

## Building (on a Mac with Xcode 16+)

```sh
cd native
npm install          # Capacitor + the push plugin (Swift Package Manager, no CocoaPods)
npx cap sync ios     # copies the config and offline page into the Xcode project
npx cap open ios     # opens Xcode
```

In Xcode: select the **App** target → Signing & Capabilities → choose your
team. The Push Notifications capability is already in `App.entitlements`.
Run on a real iPhone (the simulator can't receive APNs pushes from a server).

A build run from Xcode gets a **sandbox** token; TestFlight and App Store
builds get production ones. The app always registers as production, and
`send-push` retries a `BadDeviceToken` on the sandbox host once and remembers
it, so both just work.

**TestFlight**: Product → Archive → Distribute App → App Store Connect →
Upload. Then add testers in App Store Connect → TestFlight.

## Testing push end to end

1. Install from Xcode or TestFlight, sign in, tap the 🔔 bell and allow
   notifications. A row should appear in `apns_devices`.
2. Have a friend challenge or roast you, or wait for a result. The push
   arrives through Apple; tapping it opens the challenge inbox or the roast
   sheet, the same routing the web's service worker does.
3. If nothing arrives: the function logs say `apns send failed <status> <reason>`.
   `InvalidProviderToken` means the key / key id / team id don't match;
   `TopicDisallowed` or `DeviceTokenNotForTopic` means `APNS_TOPIC` isn't the
   app's bundle id. If the first push fails with no status at all (status 0),
   the runtime couldn't open the HTTP/2 connection APNs requires: report that,
   it needs a different transport.

## Still to do before submitting

See the App Store checklist in `docs/MODERNIZATION.md`. In short: Wikimedia
per-image credits and ESPN headshots in the store build, Universal Links so
room and invite links open the app instead of Safari, app icon and
screenshots, and a second native feature (widgets, Live Activities) to make
the 4.2 "more than a website" case stronger.
