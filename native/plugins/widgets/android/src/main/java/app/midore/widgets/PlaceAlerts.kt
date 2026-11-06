package app.midore.widgets

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import org.json.JSONArray
import org.json.JSONObject

/**
 * Place alerts ("remind me when I get home") as geofences: Android watches the places with the app closed and
 * PlaceAlertReceiver posts the notification. Geofences need location "Allow all the time"; the app asks once a day
 * at most, and registers the places once it has it. Each fires every time the person arrives (or leaves) until the
 * task is done; the app replaces the whole set whenever it changes.
 */
object PlaceAlerts {
    private const val PREFS = "midore_places"
    private const val CHANNEL = "midore_places"
    private const val ASK_EVERY_MS = 24 * 60 * 60 * 1000L

    private fun pendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, PlaceAlertReceiver::class.java)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(context, 7301, intent, flags)
    }

    private fun granted(context: Context, permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /** Ask for location, at most once a day: first "while using", then (Android 10+) "all the time". */
    private fun askForLocation(activity: Activity) {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong("askedAt", 0) < ASK_EVERY_MS) return
        prefs.edit().putLong("askedAt", now).apply()
        activity.runOnUiThread {
            if (!granted(activity, Manifest.permission.ACCESS_FINE_LOCATION)) {
                ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 7301)
            } else if (Build.VERSION.SDK_INT >= 29) {
                ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), 7302)
            }
        }
    }

    /** Replace the watched places. Returns whether they are registered (false while permission is missing). */
    @SuppressLint("MissingPermission")
    fun set(activity: Activity, fences: JSONArray, done: (Boolean) -> Unit) {
        val context = activity.applicationContext
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("fences", fences.toString()).apply()
        val client = LocationServices.getGeofencingClient(context)
        client.removeGeofences(pendingIntent(context)).addOnCompleteListener {
            if (fences.length() == 0) return@addOnCompleteListener done(true)
            val background = Build.VERSION.SDK_INT < 29 || granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            if (!granted(context, Manifest.permission.ACCESS_FINE_LOCATION) || !background) {
                askForLocation(activity)
                return@addOnCompleteListener done(false)
            }
            val list = (0 until minOf(fences.length(), 18)).map { i ->
                val f = fences.getJSONObject(i)
                Geofence.Builder()
                    .setRequestId(f.getString("id"))
                    .setCircularRegion(f.getDouble("lat"), f.getDouble("lng"), f.getDouble("radius").toFloat().coerceIn(100f, 2000f))
                    .setExpirationDuration(Geofence.NEVER_EXPIRE)
                    .setTransitionTypes(if (f.optBoolean("onArrive", true)) Geofence.GEOFENCE_TRANSITION_ENTER else Geofence.GEOFENCE_TRANSITION_EXIT)
                    .build()
            }
            // No alert just for already being there when the place is registered.
            val request = GeofencingRequest.Builder().setInitialTrigger(0).addGeofences(list).build()
            client.addGeofences(request, pendingIntent(context))
                .addOnSuccessListener { done(true) }
                .addOnFailureListener { done(false) }
        }
    }

    fun fence(context: Context, id: String): JSONObject? {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("fences", null) ?: return null
        val list = JSONArray(raw)
        for (i in 0 until list.length()) if (list.getJSONObject(i).optString("id") == id) return list.getJSONObject(i)
        return null
    }

    @SuppressLint("MissingPermission")
    fun notify(context: Context, f: JSONObject) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Place reminders", NotificationManager.IMPORTANCE_HIGH))
        }
        if (Build.VERSION.SDK_INT >= 33 && !granted(context, Manifest.permission.POST_NOTIFICATIONS)) return
        val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val tap = open?.let { PendingIntent.getActivity(context, 7302, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
        val note = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(context.applicationInfo.icon)
            .setContentTitle(f.optString("title"))
            .setContentText(f.optString("body"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .apply { if (tap != null) setContentIntent(tap) }
            .build()
        NotificationManagerCompat.from(context).notify(f.optString("id").hashCode(), note)
    }
}

/** Android calls this when the person arrives at or leaves a watched place, even with the app closed. */
class PlaceAlertReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) return
        for (g in event.triggeringGeofences ?: emptyList()) {
            PlaceAlerts.fence(context, g.requestId)?.let { PlaceAlerts.notify(context, it) }
        }
    }
}
