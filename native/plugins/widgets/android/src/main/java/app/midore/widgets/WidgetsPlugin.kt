package app.midore.widgets

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SessionArgs {
    var token: String? = null
    var baseUrl: String = ""
}

@InvokeArg
class AuthArgs {
    var url: String = ""
    var scheme: String = ""
}

/**
 * Shares the device token and server address with Midore's home-screen widgets (they live in the app module, see
 * native/widgets/android) and asks them to refresh.
 */
@TauriPlugin
class WidgetsPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun setSession(invoke: Invoke) {
        val args = invoke.parseArgs(SessionArgs::class.java)
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            if (args.token != null) putString("token", args.token) else remove("token")
            putString("baseUrl", args.baseUrl)
        }.apply()
        activity.sendBroadcast(Intent(REFRESH).setPackage(activity.packageName))
        invoke.resolve()
    }

    /** Replace the places the phone watches for arriving and leaving alerts (see PlaceAlerts). */
    @Command
    fun setPlaceAlerts(invoke: Invoke) {
        val raw = invoke.getRawArgs()
        val fences = org.json.JSONObject(raw).optJSONArray("fences") ?: org.json.JSONArray()
        PlaceAlerts.set(activity, fences) { registered ->
            invoke.resolve(JSObject().put("registered", registered))
        }
    }

    /**
     * Sign-in in a Custom Tab over the app (Chrome's in-app browser). The page ends on a midore:// link, which
     * reopens MainActivity (singleTask), closing the tab; the app picks the link up as a deep link.
     */
    @Command
    fun authenticate(invoke: Invoke) {
        val args = invoke.parseArgs(AuthArgs::class.java)
        activity.runOnUiThread {
            try {
                CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, Uri.parse(args.url))
            } catch (e: Exception) {
                // No browser with Custom Tabs: use the default browser.
                activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(args.url)))
            }
            invoke.resolve(JSObject())
        }
    }

    companion object {
        const val PREFS = "midore_widgets"
        const val REFRESH = "app.midore.widgets.REFRESH"
    }
}
