import AuthenticationServices
import SwiftRs
import Tauri
import UIKit
import WebKit
import WidgetKit

/// Shares the device token and server address with Midore's widget extension through the App Group, then asks
/// iOS to refresh the widgets. The extension reads the same keys (see native/widgets/apple/Shared/Session.swift).
class SessionArgs: Decodable {
  let token: String?
  let baseUrl: String
}

class AuthArgs: Decodable {
  let url: String
  let scheme: String
}

class WidgetsPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
  static let appGroup = "group.app.midore"
  private var authSession: ASWebAuthenticationSession?

  /// The page lays itself out edge to edge (viewport-fit=cover with safe-area padding). By default the web view
  /// also insets it by the safe areas, which leaves an empty band at the bottom of the screen.
  override func load(webview: WKWebView) {
    webview.scrollView.contentInsetAdjustmentBehavior = .never
  }

  /// What's on now as a Live Activity on the Lock Screen and in the Dynamic Island, or nothing.
  @objc public func setActivity(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ActivityArgs.self)
    Task {
      await LiveActivities.set(args.activity)
      invoke.resolve()
    }
  }

  /// Replace the places the phone watches for arriving and leaving alerts.
  @objc public func setPlaceAlerts(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PlaceFencesArgs.self)
    PlaceAlerts.set(args.fences) { invoke.resolve() }
  }

  /// Sign-in in Apple's in-app browser sheet. It shares Safari's cookies, and closes by itself when the page
  /// sends the person to a `midore://` link, which comes back here.
  @objc public func authenticate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AuthArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("Invalid sign-in address")
      return
    }
    DispatchQueue.main.async {
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: args.scheme) { callback, error in
        self.authSession = nil
        if let callback {
          invoke.resolve(["url": callback.absoluteString])
        } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
          invoke.reject("cancelled")
        } else {
          invoke.reject(error?.localizedDescription ?? "Sign-in didn't finish.")
        }
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = false
      self.authSession = session
      if !session.start() {
        self.authSession = nil
        invoke.reject("Couldn't open sign-in.")
      }
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    return manager.viewController?.view.window ?? ASPresentationAnchor()
  }

  @objc public func setSession(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SessionArgs.self)
    let defaults = UserDefaults(suiteName: WidgetsPlugin.appGroup)
    if let token = args.token {
      defaults?.set(token, forKey: "token")
    } else {
      defaults?.removeObject(forKey: "token")
    }
    defaults?.set(args.baseUrl, forKey: "baseUrl")
    WidgetCenter.shared.reloadAllTimelines()
    invoke.resolve()
  }
}

@_cdecl("init_plugin_midore_widgets")
public func initPlugin() -> Plugin {
  return WidgetsPlugin()
}
