# Continuity Camera helper

This small macOS app provides a native `NSTextView` for Apple's Continuity Camera context menu. Launch the app bundle through Launch Services and pass an attachments directory plus a result-file path:

```sh
node native/build.mjs
open -nW native/build/CodexRendererContinuity.app --args \
  --output-dir /absolute/path/to/attachments \
  --result-file /absolute/path/to/result.json \
  --cancel-file /absolute/path/to/cancel.signal
```

When the window opens, right-click inside the field and choose **Import from iPhone**, then **Take Photo** or **Scan Documents**. The helper writes every received photo or scan page as a PNG. PDF scan data is rasterized one page per PNG at up to 300 dpi, capped at 6000 pixels on the longest side. After the import, it atomically writes this JSON object to the required result file and exits:

```json
{"status":"success","path":"/absolute/path/to/attachments/iphone-import-….png"}
```

For multi-page scans, the result has a `paths` array instead of `path`. Closing the window, pressing Escape, or creating the optional cancel-signal file returns `{"status":"cancelled"}`. Errors are atomically reported as `{"status":"error","message":"…"}` and also written to stderr with a nonzero exit status. The helper does not write JSON to stdout.

The helper requires macOS 13 or later, a compatible nearby iPhone, and Continuity Camera enabled and available to the signed-in Apple devices. It is built as a local app bundle with identifier `com.henry.codex-renderer.continuity-capture`, standard bundle version/platform metadata, and `PkgInfo`. To smoke-test the window without using the camera, launch in an unlocked interactive session with temporary absolute paths, press Escape, and confirm the result file contains `{"status":"cancelled"}`. The optional cancel-signal file is checked on the main run loop in common modes, including while a contextual menu is tracking; the caller owns cleanup of both temporary files after reading the result.

The system menu is opened by a real right-click on the text view. Although AppKit has public APIs for showing context menus, synthesizing a context-menu event does not reliably reproduce the Continuity Camera handoff, so the helper gives a visible instruction instead of auto-opening a fabricated menu.

References: [Supporting Continuity Camera in Your Mac App](https://developer.apple.com/documentation/appkit/supporting-continuity-camera-in-your-mac-app), [NSTextView `readSelection(from:)`](https://developer.apple.com/documentation/appkit/nstextview/readselection%28from%3A%29), [NSServicesMenuRequestor `readSelection(from:)`](https://developer.apple.com/documentation/appkit/nsservicesmenurequestor/readselection%28from%3A%29).
