# 4 GAP RUSH — Firebase login setup

The app now has UI and client code for:
- Continue with Google
- Mobile number + SMS OTP (Firebase reCAPTCHA)
- Continue as Guest (Firebase anonymous account when configured; local guest fallback otherwise)
- Cloud profile sync for points, owned outfits, equipped outfit and reward marker.

## One-time Firebase setup (required before Google/OTP/cloud sync work)

1. Open https://console.firebase.google.com/ and create a Firebase project.
2. Add a Web App and copy its config.
3. Replace the placeholder values in `public/firebase-config.js` with that web app's `apiKey`, `authDomain`, `projectId`, and `appId`.
   Firebase web config is public client configuration; do not put service-account keys or private secrets here.
4. Firebase Console → Authentication → Sign-in method:
   - Enable Google.
   - Enable Phone.
   - Enable Anonymous.
5. Authentication → Settings → Authorized domains: add the deployed Render hostname (for example, your actual `*.onrender.com` hostname). Also add any custom domain.
6. For phone OTP, set the SMS region policy to the countries you intend to support (for India, allow India). Keep reCAPTCHA enabled.
7. Build → Firestore Database → Create database.
8. In Firestore Rules, publish the contents of `firestore.rules` from this repository. These rules allow each signed-in user to read/write only their own `playerProfiles/{uid}` document.
9. Deploy the latest commit to Render and test Google, guest, phone OTP, and profile sync.

## Notes

- Firebase Authentication and Firestore are separate products; both need to be enabled.
- SMS OTP may incur charges/quotas and is subject to Firebase anti-abuse checks.
- Existing local profiles are merged with the first cloud profile on sign-in. Because the game previously stored points locally, test with a non-critical account first.
- If the config is not filled in yet, the game should still open and local guest play remains available. Google, OTP and cloud persistence intentionally show setup guidance rather than pretending to authenticate.
