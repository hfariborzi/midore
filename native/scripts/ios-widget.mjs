// Adds Midore's widget extension and App Group to Tauri's generated iOS project (src-tauri/gen/apple/project.yml)
// and regenerates the Xcode project. Safe to run again; run it after `tauri ios init`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src-tauri", "gen", "apple");
const file = join(dir, "project.yml");
let yml = readFileSync(file, "utf8");

const GROUP = "group.app.midore";

if (!yml.includes("MidoreWidgets_iOS")) {
  // The app shares the App Group with the widget and embeds it.
  yml = yml.replace(
    "    entitlements:\n      path: midore_iOS/midore_iOS.entitlements\n",
    `    entitlements:\n      path: midore_iOS/midore_iOS.entitlements\n      properties:\n        com.apple.security.application-groups: [${GROUP}]\n`,
  );
  // midore:// links (sign-in reply and widget taps) open the app.
  yml = yml.replace(
    "        LSRequiresIPhoneOS: true\n",
    "        LSRequiresIPhoneOS: true\n        CFBundleURLTypes:\n          - CFBundleURLName: app.midore\n            CFBundleURLSchemes: [midore]\n",
  );
  yml = yml.replace("    dependencies:\n      - framework: libapp.a", "    dependencies:\n      - target: MidoreWidgets_iOS\n        embed: true\n      - framework: libapp.a");
  yml += `
  MidoreWidgets_iOS:
    type: app-extension
    platform: iOS
    deploymentTarget: "17.0"
    sources:
      - path: ../../../widgets/apple/Shared
      - path: ../../../widgets/apple/Widgets
    info:
      path: MidoreWidgets_iOS/Info.plist
      properties:
        CFBundleDisplayName: Midore
        CFBundleShortVersionString: 0.1.0
        CFBundleVersion: "0.1.0"
        NSExtension:
          NSExtensionPointIdentifier: com.apple.widgetkit-extension
    entitlements:
      path: MidoreWidgets_iOS/MidoreWidgets_iOS.entitlements
      properties:
        com.apple.security.application-groups: [${GROUP}]
    settings:
      base:
        # Tauri rewrites every plain PRODUCT_BUNDLE_IDENTIFIER line to the app's id when it builds; the
        # SDK-conditional form is left alone and takes precedence in Xcode.
        PRODUCT_BUNDLE_IDENTIFIER: app.midore.widgets
        "PRODUCT_BUNDLE_IDENTIFIER[sdk=*]": app.midore.widgets
        PRODUCT_NAME: MidoreWidgets
        DEVELOPMENT_TEAM: 9437GLFKZ8
        SKIP_INSTALL: YES
        SWIFT_VERSION: "5.0"
        TARGETED_DEVICE_FAMILY: "1,2"
`;
  writeFileSync(file, yml);
}

// Place alerts ("remind me when I get home") are location-triggered notifications: iOS asks for "While Using".
if (!yml.includes("NSLocationWhenInUseUsageDescription")) {
  yml = yml.replace("        LSRequiresIPhoneOS: true\n", '        LSRequiresIPhoneOS: true\n        NSLocationWhenInUseUsageDescription: "Midore uses your location only to alert you when you arrive at or leave a place you saved, like Home or Work."\n');
}

// Live Activities: what's on now on the Lock Screen and in the Dynamic Island (started by the app).
if (!yml.includes("NSSupportsLiveActivities")) {
  yml = yml.replace("        LSRequiresIPhoneOS: true\n", "        LSRequiresIPhoneOS: true\n        NSSupportsLiveActivities: true\n");
}

// Share to Midore: a share extension that turns shared text or links into tasks.
if (!yml.includes("MidoreShare_iOS")) {
  yml = yml.replace("      - target: MidoreWidgets_iOS\n        embed: true\n", "      - target: MidoreWidgets_iOS\n        embed: true\n      - target: MidoreShare_iOS\n        embed: true\n");
  yml += `
  MidoreShare_iOS:
    type: app-extension
    platform: iOS
    deploymentTarget: "17.0"
    sources:
      - path: ../../../widgets/apple/Shared
      - path: ../../../widgets/apple/Share
    info:
      path: MidoreShare_iOS/Info.plist
      properties:
        CFBundleDisplayName: Midore
        CFBundleShortVersionString: 0.1.0
        CFBundleVersion: "0.1.0"
        NSExtension:
          NSExtensionPointIdentifier: com.apple.share-services
          NSExtensionPrincipalClass: ShareViewController
          NSExtensionAttributes:
            NSExtensionActivationRule:
              NSExtensionActivationSupportsText: true
              NSExtensionActivationSupportsWebURLWithMaxCount: 1
    entitlements:
      path: MidoreShare_iOS/MidoreShare_iOS.entitlements
      properties:
        com.apple.security.application-groups: [${GROUP}]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: app.midore.share
        "PRODUCT_BUNDLE_IDENTIFIER[sdk=*]": app.midore.share
        PRODUCT_NAME: MidoreShare
        DEVELOPMENT_TEAM: 9437GLFKZ8
        SKIP_INSTALL: YES
        SWIFT_VERSION: "5.0"
        TARGETED_DEVICE_FAMILY: "1,2"
`;
}
// Simulator builds are unsigned (--no-sign), and the simulator reads entitlements from a section in the binary
// that Xcode only adds when signing. Without it the app and its extensions don't share the App Group, and widgets
// say "sign in" while the app is signed in. Add the section ourselves for simulator builds.
const SIM_ENTS = (path) =>
  `        "OTHER_LDFLAGS[sdk=iphonesimulator*]": $(inherited) -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker $(PROJECT_DIR)/${path}\n`;
for (const [target, path] of [
  ["midore_iOS", "midore_iOS/midore_iOS.entitlements"],
  ["MidoreWidgets_iOS", "MidoreWidgets_iOS/MidoreWidgets_iOS.entitlements"],
  ["MidoreShare_iOS", "MidoreShare_iOS/MidoreShare_iOS.entitlements"],
]) {
  if (yml.includes(`__entitlements -Xlinker $(PROJECT_DIR)/${path}`)) continue;
  const at = yml.indexOf(`\n  ${target}:\n`);
  const base = yml.indexOf("      base:\n", at);
  if (at < 0 || base < 0) throw new Error(`no settings for ${target}`);
  const insert = base + "      base:\n".length;
  yml = yml.slice(0, insert) + SIM_ENTS(path) + yml.slice(insert);
}
writeFileSync(file, yml);

execFileSync("xcodegen", ["generate", "--quiet"], { cwd: dir, stdio: "inherit" });
console.log("iOS project: widgets, Live Activities, share extension and App Group in place.");
