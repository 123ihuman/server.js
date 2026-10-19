=== FILE: schema.sql ===

CREATE DATABASE lastbreath;
\c lastbreath;

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    phone VARCHAR(20),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE devices (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    imei VARCHAR(50) UNIQUE NOT NULL,
    sim_serial VARCHAR(50),
    device_id VARCHAR(255),
    brand VARCHAR(50),
    model VARCHAR(50),
    android_version VARCHAR(20),
    last_location VARCHAR(100),
    last_location_timestamp TIMESTAMP,
    last_seen TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active',
    is_blacklisted BOOLEAN DEFAULT FALSE,
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE alerts (
    id SERIAL PRIMARY KEY,
    device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    alert_type VARCHAR(50),
    location VARCHAR(100),
    message TEXT,
    is_resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trusted_contacts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    contact_name VARCHAR(100),
    contact_phone VARCHAR(20),
    contact_email VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE community_reports (
    id SERIAL PRIMARY KEY,
    device_imei VARCHAR(50) REFERENCES devices(imei) ON DELETE CASCADE,
    reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    location VARCHAR(100),
    notes TEXT,
    is_verified BOOLEAN DEFAULT FALSE,
    reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rewards (
    id SERIAL PRIMARY KEY,
    device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    reward_amount DECIMAL(10,2),
    reward_currency VARCHAR(10) DEFAULT 'INR',
    reward_status VARCHAR(20) DEFAULT 'pending',
    payment_method VARCHAR(20),
    payment_details TEXT,
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    device_info TEXT,
    expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '7 days',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE imei_blacklist (
    id SERIAL PRIMARY KEY,
    imei VARCHAR(50) UNIQUE NOT NULL,
    reason VARCHAR(100) DEFAULT 'stolen',
    reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_national BOOLEAN DEFAULT FALSE,
    is_international BOOLEAN DEFAULT FALSE,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_devices_imei ON devices(imei);
CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_devices_status ON devices(status);
CREATE INDEX idx_alerts_device_id ON alerts(device_id);
CREATE INDEX idx_alerts_created_at ON alerts(created_at);
CREATE INDEX idx_reports_device_imei ON community_reports(device_imei);
CREATE INDEX idx_blacklist_imei ON imei_blacklist(imei);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();