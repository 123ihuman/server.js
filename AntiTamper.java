package com.lastbreath.antitheft;

import android.app.admin.DeviceAdminReceiver;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class AntiTamper {
    public static class AntiTheftDeviceAdmin extends DeviceAdminReceiver {
        @Override
        public void onEnabled(Context context, Intent intent) {
            super.onEnabled(context, intent);
            Log.d("AntiTamper", "Device admin enabled");
            // Automatically hide app from launcher
            try {
                DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
                ComponentName admin = new ComponentName(context, AntiTheftDeviceAdmin.class);
                if (dpm.isAdminActive(admin)) {
                    dpm.setApplicationHidden(admin, context.getPackageName(), true);
                }
            } catch (Exception e) { Log.e("AntiTamper", "Hide failed", e); }
        }
    }
}