package com.lastbreath.antitheft;

import android.content.Context;
import android.content.SharedPreferences;
import android.telephony.SmsManager;
import android.util.Log;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class AlertSender {
    private Context context;
    private SharedPreferences prefs;
    public AlertSender(Context context) {
        this.context = context;
        this.prefs = context.getSharedPreferences("LastBreathPrefs", MODE_PRIVATE);
    }
    public void sendAlerts(String message) {
        String phone1 = prefs.getString("trustedPhone1", "");
        String phone2 = prefs.getString("trustedPhone2", "");
        String imei = prefs.getString("imei", "Unknown");
        String location = prefs.getString("lastLocation", "Unknown");
        String full = message + " IMEI: " + imei + " Location: " + location;
        sendSms(phone1, full);
        sendSms(phone2, full);
        sendToServer(full, location);
    }
    private void sendSms(String number, String msg) {
        if (number == null || number.isEmpty()) return;
        try { SmsManager.getDefault().sendTextMessage(number, null, msg, null, null); } catch (Exception e) { Log.e("AlertSender", "SMS failed", e); }
    }
    private void sendToServer(String message, String location) {
        String serverUrl = prefs.getString("serverUrl", "");
        if (serverUrl.isEmpty()) return;
        new Thread(() -> {
            try {
                URL url = new URL(serverUrl + "/alerts");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                JSONObject json = new JSONObject();
                json.put("imei", prefs.getString("imei", "Unknown"));
                json.put("location", location);
                json.put("message", message);
                json.put("alert_type", "security");
                OutputStream os = conn.getOutputStream();
                os.write(json.toString().getBytes());
                os.flush();
                os.close();
                conn.getResponseCode();
            } catch (Exception e) { Log.e("AlertSender", "Server send failed", e); }
        }).start();
    }
}