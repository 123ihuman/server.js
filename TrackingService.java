package com.lastbreath.antitheft;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.telephony.TelephonyManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class TrackingService extends Service {
    private static final String CHANNEL_ID = "last_breath_channel";
    private static final int NOTIFICATION_ID = 1001;
    private SharedPreferences prefs;
    private FusedLocationProviderClient fusedLocationClient;
    private LocationCallback locationCallback;
    private Handler handler;
    private Runnable trackingRunnable;
    private String lastKnownLocation = "";
    private String savedSim = "";
    private String imei = "";

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("LastBreathPrefs", MODE_PRIVATE);
        imei = prefs.getString("imei", "Unknown");
        savedSim = prefs.getString("sim", "");
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this);
        handler = new Handler(Looper.getMainLooper());
        setupLocationUpdates();
        startPeriodicChecks();
    }

    private void setupLocationUpdates() {
        LocationRequest locationRequest = LocationRequest.create();
        locationRequest.setInterval(60000);
        locationRequest.setFastestInterval(30000);
        locationRequest.setPriority(LocationRequest.PRIORITY_HIGH_ACCURACY);
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult locationResult) {
                if (locationResult == null) return;
                for (Location location : locationResult.getLocations()) {
                    lastKnownLocation = location.getLatitude() + "," + location.getLongitude();
                    prefs.edit().putString("lastLocation", lastKnownLocation).apply();
                    sendLocationToServer(lastKnownLocation);
                }
            }
        };
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            fusedLocationClient.requestLocationUpdates(locationRequest, locationCallback, Looper.getMainLooper());
        }
    }

    private void startPeriodicChecks() {
        trackingRunnable = new Runnable() {
            @Override
            public void run() {
                checkSimChange();
                sendHeartbeat();
                handler.postDelayed(this, 120000);
            }
        };
        handler.postDelayed(trackingRunnable, 30000);
    }

    private void checkSimChange() {
        TelephonyManager tm = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            String currentSim = tm.getSimSerialNumber();
            if (currentSim != null && !currentSim.equals(savedSim) && !savedSim.equals("")) {
                Log.w("TrackingService", "SIM CHANGED!");
                prefs.edit().putString("sim", currentSim).apply();
                new AlertSender(this).sendAlerts("SIM card has been changed! Phone may be stolen.");
                lockPhone();
            }
        }
    }

    private void sendLocationToServer(String location) {
        String serverUrl = prefs.getString("serverUrl", "");
        if (serverUrl.isEmpty()) return;
        new Thread(() -> {
            try {
                URL url = new URL(serverUrl + "/location");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                JSONObject json = new JSONObject();
                json.put("imei", imei);
                json.put("location", location);
                OutputStream os = conn.getOutputStream();
                os.write(json.toString().getBytes());
                os.flush();
                os.close();
                conn.getResponseCode();
            } catch (Exception e) { Log.e("TrackingService", "Location send failed", e); }
        }).start();
    }

    private void sendHeartbeat() {
        String serverUrl = prefs.getString("serverUrl", "");
        if (serverUrl.isEmpty()) return;
        new Thread(() -> {
            try {
                URL url = new URL(serverUrl + "/heartbeat");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                JSONObject json = new JSONObject();
                json.put("imei", imei);
                json.put("status", "active");
                json.put("last_location", lastKnownLocation);
                OutputStream os = conn.getOutputStream();
                os.write(json.toString().getBytes());
                os.flush();
                os.close();
            } catch (Exception e) { Log.e("TrackingService", "Heartbeat failed", e); }
        }).start();
    }

    private void lockPhone() {
        try {
            android.app.admin.DevicePolicyManager dpm = (android.app.admin.DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
            android.content.ComponentName admin = new android.content.ComponentName(this, AntiTamper.AntiTheftDeviceAdmin.class);
            if (dpm.isAdminActive(admin)) dpm.lockNow();
        } catch (Exception e) { Log.e("TrackingService", "Lock failed", e); }
    }

    private Notification buildNotification() {
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Last Breath")
                .setContentText("🔴 Anti-theft protection active")
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOngoing(true)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Last Breath", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Anti-theft service");
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            manager.createNotificationChannel(channel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }
    @Override
    public void onDestroy() {
        super.onDestroy();
        if (locationCallback != null) fusedLocationClient.removeLocationUpdates(locationCallback);
        if (handler != null && trackingRunnable != null) handler.removeCallbacks(trackingRunnable);
        Intent restartIntent = new Intent(this, TrackingService.class);
        startService(restartIntent);
    }
    @Override
    public IBinder onBind(Intent intent) { return null; }
}