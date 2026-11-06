import CoreLocation
import Foundation
import UserNotifications

/// A saved place the phone watches for an alert on arriving or leaving.
class PlaceFence: Decodable {
  let id: String
  let title: String
  let body: String
  let lat: Double
  let lng: Double
  let radius: Double
  let onArrive: Bool
}

class PlaceFencesArgs: Decodable {
  let fences: [PlaceFence]
}

/// Place alerts as location-triggered local notifications: iOS watches the regions itself, with the app closed,
/// and needs only "While Using the App" location permission. Each fires every time the person arrives (or
/// leaves) until the task is done; the app replaces the whole set whenever it changes.
enum PlaceAlerts {
  static let prefix = "midore-place:"
  private static let manager = CLLocationManager()

  static func set(_ fences: [PlaceFence], done: @escaping () -> Void) {
    let center = UNUserNotificationCenter.current()
    center.getPendingNotificationRequests { pending in
      let old = pending.map(\.identifier).filter { $0.hasPrefix(prefix) }
      center.removePendingNotificationRequests(withIdentifiers: old)
      guard !fences.isEmpty else { return done() }
      DispatchQueue.main.async {
        if manager.authorizationStatus == .notDetermined {
          manager.requestWhenInUseAuthorization()
        }
        for f in fences.prefix(18) {
          let region = CLCircularRegion(
            center: CLLocationCoordinate2D(latitude: f.lat, longitude: f.lng),
            radius: min(max(f.radius, 100), 2000),
            identifier: f.id
          )
          region.notifyOnEntry = f.onArrive
          region.notifyOnExit = !f.onArrive
          let content = UNMutableNotificationContent()
          content.title = f.title
          content.body = f.body
          content.sound = .default
          let trigger = UNLocationNotificationTrigger(region: region, repeats: true)
          center.add(UNNotificationRequest(identifier: prefix + f.id, content: content, trigger: trigger))
        }
        done()
      }
    }
  }
}
