# Dashboard Quick Start Guide

## Access the Dashboard

Open your browser to:
```
http://localhost:3000/dashboard
```

## Features

### 1. API Keys Management

**Add a new API key:**
1. Click the "Add Key" button in the API Keys card
2. Enter key name (e.g., "Primary Key")
3. Paste your Command Code API key (starts with `user_`)
4. Set status to Active/Inactive
5. Click "Save Key"

**Edit an existing key:**
1. Click the pencil icon on the key row
2. Modify name, value, or status
3. Click "Save Key"

**Delete a key:**
1. Click the trash icon
2. Confirm deletion

### 2. Models Configuration

Toggle models on/off using the switch next to each model:
- DeepSeek V4 Pro
- DeepSeek V4 Flash
- MiniMax M2.7
- Qwen 3.6 Plus
- GLM 5.1
- Kimi K2.6

Changes are saved automatically.

### 3. Proxy Configuration

Configure these settings:
- **Bind Host**: `localhost` (local only) or `0.0.0.0` (all interfaces)
- **Port**: Default is 3000
- **API URL**: Command Code API endpoint
- **CLI Version**: Version header (default: 0.26.24)

Click "Save Configuration" to persist changes.

### 4. Quick Actions

- **Check Health**: Verify proxy is running
- **Test Connection**: Test upstream API connection
- **Refresh Models**: Reload model list
- **Save Configuration**: Save all changes
- **Restart Proxy**: Restart the proxy server

### 5. Status Dashboard

View real-time stats:
- Total API keys configured
- Active API keys
- Enabled models count
- Current proxy port

## API Endpoints

### Manage API Keys

```bash
# List all keys
curl http://localhost:3000/api/keys

# Add a new key
curl -X POST http://localhost:3000/api/keys \
  -H "Content-Type: application/json" \
  -d '{"name":"My Key","value":"user_abc123","status":"active"}'

# Update a key (index 0)
curl -X PUT http://localhost:3000/api/keys \
  -H "Content-Type: application/json" \
  -d '{"index":0,"name":"Updated Key","value":"user_xyz789","status":"active"}'

# Delete a key (index 0)
curl -X DELETE http://localhost:3000/api/keys \
  -H "Content-Type: application/json" \
  -d '{"index":0}'
```

### Manage Models

```bash
# List all models
curl http://localhost:3000/api/models

# Update model status
curl -X POST http://localhost:3000/api/models \
  -H "Content-Type: application/json" \
  -d '{
    "models": [
      {"id":"deepseek/deepseek-v4-pro","name":"DeepSeek V4 Pro","enabled":true},
      {"id":"deepseek/deepseek-v4-flash","name":"DeepSeek V4 Flash","enabled":false}
    ]
  }'
```

### Configuration

```bash
# Get current config
curl http://localhost:3000/api/config

# Update configuration
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "bindHost":"localhost",
    "port":3000,
    "apiUrl":"https://api.commandcode.ai",
    "cliVersion":"0.26.24"
  }'
```

## Configuration File

All settings are stored in `proxy-config.json` in the proxy directory:

```json
{
  "bindHost": "localhost",
  "port": 3000,
  "apiUrl": "https://api.commandcode.ai",
  "cliVersion": "0.26.24",
  "apiKeys": [
    {
      "name": "Primary Key",
      "value": "user_abc123...",
      "status": "active"
    }
  ],
  "models": [
    {
      "id": "deepseek/deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "enabled": true
    }
  ]
}
```

## Troubleshooting

### Dashboard not loading
1. Check proxy is running: `curl http://localhost:3000/health`
2. Verify port 3000 is not in use by another application
3. Check `dashboard.html` exists in the proxy directory

### Cannot save configuration
1. Ensure proxy has write permissions to the directory
2. Check `proxy-config.json` is not read-only
3. Verify JSON format is valid

### API keys not working
1. Ensure API key starts with `user_`
2. Check key status is "active"
3. Verify key is saved in configuration

### Models not appearing
1. Check models are enabled in configuration
2. Refresh the dashboard page
3. Verify model IDs match Command Code API

## Security Notes

⚠️ **Important Security Considerations:**

1. **Local Access Only**: By default, the dashboard binds to `localhost:3000`. Do not expose to public internet without authentication.

2. **API Key Storage**: API keys are stored in plain text in `proxy-config.json`. Protect this file:
   ```cmd
   icacls proxy-config.json /grant %USERNAME%:R
   ```

3. **Network Exposure**: If binding to `0.0.0.0`, ensure firewall rules restrict access to trusted networks only.

4. **Production Use**: For production deployments, add authentication middleware to protect the dashboard and management APIs.

## Credits

Dashboard design inspired by [commandcode-bridge](https://github.com/yelixir-dev/commandcode-bridge) console.
