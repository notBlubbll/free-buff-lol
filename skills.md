# Skills: Modifying Provider Lists in opencode.json

Guide for adding, removing, and configuring LLM providers in OpenCode's `opencode.json` config.

## File Location

The config file lives at the project root or `~/.config/opencode/opencode.json`.

## Basic Structure

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "<provider_id>": {
      "models": {
        "<model_id>": {}
      }
    }
  }
}
```

Format for selecting a model: `provider_id/model_id`

---

## Add a Built-in Provider

Most popular providers are preloaded. You only need to configure them if customizing options or adding models.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "models": {
        "claude-sonnet-4-5-20250929": {
          "options": {
            "thinking": {
              "type": "enabled",
              "budgetTokens": 16000
            }
          }
        }
      }
    }
  }
}
```

Built-in provider IDs: `openai`, `anthropic`, `google`, `deepseek`, `groq`, `openrouter`, `ollama`, `lmstudio`, `nvidia`, `minimax`, `fireworks`, `cerebras`, etc. Full list at https://opencode.ai/docs/providers/

---

## Add a Custom Provider (OpenAI-compatible)

For any OpenAI-compatible API (local or remote):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1"
      },
      "models": {
        "my-model-id": {
          "name": "My Model Display Name"
        }
      }
    }
  }
}
```

Fields:
- `npm` — SDK package to use (`@ai-sdk/openai-compatible` for OpenAI-compatible APIs)
- `name` — Display name in the UI
- `options.baseURL` — API endpoint
- `models` — Map of model IDs to display names

---

## Add Models to an Existing Provider

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openrouter": {
      "models": {
        "somecoolnewmodel": {},
        "another/model": {}
      }
    }
  }
}
```

Models listed in config merge with preloaded defaults.

---

## Configure Model Options

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openai": {
      "models": {
        "gpt-5": {
          "options": {
            "reasoningEffort": "high",
            "textVerbosity": "low",
            "reasoningSummary": "auto"
          }
        }
      }
    }
  }
}
```

---

## Add Variants

Variants let you configure different settings for the same model:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openai": {
      "models": {
        "gpt-5": {
          "variants": {
            "high": {
              "reasoningEffort": "high"
            },
            "fast": {
              "reasoningEffort": "low",
              "textVerbosity": "low"
            }
          }
        }
      }
    }
  }
}
```

Built-in variant names: `high`, `max`, `none`, `minimal`, `low`, `medium`, `xhigh` (varies by provider).

---

## Set a Custom Base URL

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "https://proxy.example.com/v1"
      }
    }
  }
}
```

---

## Set the Default Model

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5-20250929"
}
```

Loading priority: `--model` flag > config `model` > last used > internal default.

---

## Full Example

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "deepseek/deepseek-v4-pro",
  "provider": {
    "deepseek": {
      "models": {
        "deepseek-v4-pro": {
          "options": {
            "reasoningEffort": "high"
          }
        }
      }
    },
    "openai": {
      "models": {
        "gpt-5": {
          "variants": {
            "high": {
              "reasoningEffort": "high",
              "textVerbosity": "low"
            },
            "low": {
              "reasoningEffort": "low"
            }
          }
        }
      }
    },
    "my-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local Server",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1"
      },
      "models": {
        "qwen3-coder": {
          "name": "Qwen3 Coder"
        }
      }
    }
  }
}
```

---

## Amazon Bedrock Example

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "amazon-bedrock": {
      "options": {
        "region": "us-east-1",
        "profile": "my-aws-profile"
      },
      "models": {
        "anthropic-claude-sonnet-4.5": {
          "id": "arn:aws:bedrock:us-east-1:xxx:application-inference-profile/yyy"
        }
      }
    }
  }
}
```

---

## Provider with Custom Headers

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "helicone": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Helicone",
      "options": {
        "baseURL": "https://ai-gateway.helicone.ai",
        "headers": {
          "Helicone-Cache-Enabled": "true",
          "Helicone-User-Id": "opencode"
        }
      }
    }
  }
}
```

---

## Quick Reference

| Task | Key |
|------|-----|
| Add provider | `provider.<id>` |
| Add model | `provider.<id>.models.<model_id>` |
| Set base URL | `provider.<id>.options.baseURL` |
| Set display name | `provider.<id>.name` |
| Set SDK package | `provider.<id>.npm` |
| Configure model options | `provider.<id>.models.<model_id>.options` |
| Add variants | `provider.<id>.models.<model_id>.variants.<name>` |
| Set default model | `model` (top-level) |

Source: https://opencode.ai/docs/models/#configure-models
