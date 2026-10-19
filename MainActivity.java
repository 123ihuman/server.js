package com.lastbreath.antitheft;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.telephony.TelephonyManager;
import android.text.TextUtils;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {
    private static final int PERMISSION_REQUEST_CODE = 100;
    private SharedPreferences prefs;
    private EditText etEmail, etPhone1, etPhone2, etServerUrl;
    private Button btnRegister, btnEnableTracking, btnDashboard;
    private TextView tvStatus, tvImei, tvDeviceId;
    private String imei = "", deviceId = "", simSerial = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences("LastBreathPrefs", MODE_PRIVATE);

        etEmail = findViewById(R.id.etEmail);
        etPhone1 = findViewById(R.id.etPhone1);
        etPhone2 = findViewById(R.id.etPhone2);
        etServerUrl = findViewById(R.id.etServerUrl);
        btnRegister = findViewById(R.id.btnRegister);
        btnEnableTracking = findViewById(R.id.btnEnableTracking);
        btnDashboard = findViewById(R.id.btnDashboard);
        tvStatus = findViewById(R.id.tvStatus);
        tvImei = findViewById(R.id.tvImei);
        tvDeviceId = findViewById(R.id.tvDeviceId);

        etServerUrl.setText(prefs.getString("serverUrl", "https://your-server.com/api"));

        getDeviceDetails();
        tvImei.setText("IMEI: " + imei);
        tvDeviceId.setText("Device ID: " + deviceId);

        checkPermissions();

        if (prefs.getBoolean("registered", false)) {
            btnRegister.setEnabled(false);
            btnRegister.setText("✅ Registered");
            btnEnableTracking.setEnabled(true);
            btnDashboard.setVisibility(View.VISIBLE);
        }

        btnRegister.setOnClickListener(v -> registerDevice());
        btnEnableTracking.setOnClickListener(v -> enableTracking());
        btnDashboard.setOnClickListener(v -> {
            Intent intent = new Intent(MainActivity.this, DashboardActivity.class);
            startActivity(intent);
        });
    }

    private void getDeviceDetails() {
        TelephonyManager tm = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            imei = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? tm.getImei() : tm.getDeviceId();
            simSerial = tm.getSimSerialNumber();
        }
        deviceId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        if (TextUtils.isEmpty(imei)) imei = "UNKNOWN";
        if (TextUtils.isEmpty(simSerial)) simSerial = "NO_SIM";
    }

    private void checkPermissions() {
        String[] perms = {
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.SEND_SMS,
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION,
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.RECEIVE_BOOT_COMPLETED,
                Manifest.permission.FOREGROUND_SERVICE,
                Manifest.permission.BLUETOOTH,
                Manifest.permission.BLUETOOTH_ADMIN,
                Manifest.permission.USE_BIOMETRIC
        };
        List<String> needed = new ArrayList<>();
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                needed.add(p);
            }
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        }
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER) && !lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
        }
    }

    private void registerDevice() {
        String email = etEmail.getText().toString().trim();
        String phone1 = etPhone1.getText().toString().trim();
        String phone2 = etPhone2.getText().toString().trim();
        String serverUrl = etServerUrl.getText().toString().trim();
        if (TextUtils.isEmpty(email) || TextUtils.isEmpty(phone1) || TextUtils.isEmpty(serverUrl)) {
            Toast.makeText(this, "Please fill all required fields", Toast.LENGTH_SHORT).show();
            return;
        }
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString("trustedEmail", email);
        editor.putString("trustedPhone1", phone1);
        editor.putString("trustedPhone2", phone2);
        editor.putString("serverUrl", serverUrl);
        editor.putString("imei", imei);
        editor.putString("sim", simSerial);
        editor.putString("deviceId", deviceId);
        editor.putString("brand", Build.BRAND);
        editor.putString("model", Build.MODEL);
        editor.putString("androidVersion", Build.VERSION.RELEASE);
        editor.putBoolean("registered", true);
        editor.apply();

        new Thread(() -> {
            try {
                URL url = new URL(serverUrl + "/devices");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                JSONObject json = new JSONObject();
                json.put("imei", imei);
                json.put("sim_serial", simSerial);
                json.put("device_id", deviceId);
                json.put("brand", Build.BRAND);
                json.put("model", Build.MODEL);
                json.put("android_version", Build.VERSION.RELEASE);
                OutputStream os = conn.getOutputStream();
                os.write(json.toString().getBytes());
                os.flush();
                os.close();
                int response = conn.getResponseCode();
                runOnUiThread(() -> {
                    if (response >= 200 && response < 300) {
                        Toast.makeText(MainActivity.this, "Device Registered!", Toast.LENGTH_LONG).show();
                        btnRegister.setEnabled(false);
                        btnRegister.setText("✅ Registered");
                        btnEnableTracking.setEnabled(true);
                        btnDashboard.setVisibility(View.VISIBLE);
                    } else {
                        Toast.makeText(MainActivity.this, "Server error: " + response, Toast.LENGTH_LONG).show();
                    }
                });
            } catch (Exception e) {
                Log.e("MainActivity", "Register error", e);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Network error: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void enableTracking() {
        if (!prefs.getBoolean("registered", false)) {
            Toast.makeText(this, "Register first", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent serviceIntent = new Intent(this, TrackingService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
        Toast.makeText(this, "Tracking Enabled!", Toast.LENGTH_LONG).show();
        tvStatus.setText("🟢 Tracking Active");
        tvStatus.setTextColor(getColor(android.R.color.holo_green_dark));
        prefs.edit().putBoolean("trackingEnabled", true).apply();
    }
}