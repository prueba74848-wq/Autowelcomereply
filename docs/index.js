(function () {
  "use strict";
  var module = { exports: {} };

  // Delay before sending, in ms (random between min and max). Editable in settings.
  var DEFAULT_MIN_DELAY = 10;
  var DEFAULT_MAX_DELAY = 100;

  var DEFAULT_MESSAGE = "Are you an alt?";

  var vd = vendetta;
  var logger = vd.logger;
  var findByProps = vd.metro.findByProps;
  var findByStoreName = vd.metro.findByStoreName;

  // Same lookups AutoReact uses (these are known to resolve on the Android TV build)
  var HTTP = findByProps("put", "del", "patch", "post", "get", "getAPIBaseURL");
  var TokenStore = findByStoreName("UserAuthTokenStore") || findByStoreName("AuthenticationStore");
  var UserStore = findByStoreName("UserStore") || findByProps("getCurrentUser", "getUser");
  var ChannelStore = findByStoreName("ChannelStore");
  var GuildStore = findByStoreName("GuildStore");
  var FD = findByProps("_interceptors");

  // Only used as fallbacks
  var FluxDispatcher = vd.metro.common.FluxDispatcher;
  var MessageActions = findByProps("sendMessage", "receiveMessage");

  // Settings UI pieces
  var React = vd.metro.common.React;
  var RN = vd.metro.common.ReactNative;
  var Forms = vd.ui.components.Forms;
  var useProxy = vd.storage.useProxy;
  var storage = vd.plugin.storage;

  var API_BASE = "https://discord.com/api/v9";
  var USER_JOIN = 7;
  var greeted = new Set();
  var interceptFn = null;
  var subscribedFn = null;

  // ---------- Settings storage ----------
  // storage.message    : string, the text sent in reply to a join message
  // storage.allGuilds  : boolean, greet in every server
  // storage.guildIds   : string, server IDs separated by commas/spaces (used when allGuilds is off)
  function ensureDefaults() {
    if (typeof storage.message !== "string") storage.message = DEFAULT_MESSAGE;
    if (typeof storage.debug !== "boolean") storage.debug = true;
    if (typeof storage.minDelay !== "string") storage.minDelay = String(DEFAULT_MIN_DELAY);
    if (typeof storage.maxDelay !== "string") storage.maxDelay = String(DEFAULT_MAX_DELAY);
    if (typeof storage.allGuilds !== "boolean") storage.allGuilds = false;
    if (typeof storage.guildIds !== "string") {
      // migrate any servers picked in the old list
      var old = storage.guilds && typeof storage.guilds === "object"
        ? Object.keys(storage.guilds).filter(function (k) { return storage.guilds[k]; })
        : [];
      storage.guildIds = old.join(", ");
    }
  }
  ensureDefaults();

  function getDelays() {
    var min = parseInt(storage.minDelay, 10);
    var max = parseInt(storage.maxDelay, 10);
    if (!isFinite(min) || min < 0) min = DEFAULT_MIN_DELAY;
    if (!isFinite(max) || max < 0) max = DEFAULT_MAX_DELAY;
    if (max < min) { var t = min; min = max; max = t; }
    return { min: min, max: max };
  }

  function getMessage() {
    return String(storage.message || "").trim();
  }

  function guildAllowed(guildId) {
    if (storage.allGuilds) return true;
    return !!(guildId && getGuildIds().indexOf(String(guildId)) !== -1);
  }

  function getGuildIds() {
    return String(storage.guildIds || "")
      .split(/[,\s]+/)
      .filter(function (x) { return /^\d{15,25}$/.test(x); });
  }

  // ---------- Helpers ----------
  function toast(text) {
    logger.log("[Auto Welcome Reply] " + text);
    try {
      vd.ui.toasts.showToast("[Auto Welcome Reply] " + text, vd.ui.assets.getAssetIDByName("Small"));
    } catch (e) {
      logger.log("[Auto Welcome Reply] toast failed: " + String(e));
    }
  }

  function dbg(text) {
    if (storage.debug) toast(text);
  }

  function getToken() {
    try {
      if (!TokenStore) return null;
      return TokenStore.getToken ? TokenStore.getToken() : TokenStore.token;
    } catch (e) {
      return null;
    }
  }

  function currentUserId() {
    try {
      var me = UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser();
      return me && me.id;
    } catch (e) {
      return null;
    }
  }

  function guildOf(payload, message, channelId) {
    if (payload.guildId) return payload.guildId;
    if (message.guild_id) return message.guild_id;
    try {
      var ch = ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(channelId);
      return ch && ch.guild_id;
    } catch (e) {
      return null;
    }
  }

  function sendReply(channelId, guildId, messageId) {
    var text = getMessage();
    if (!text) {
      toast("no message set (open plugin settings)");
      return;
    }

    // Preferred: send straight through Discord's REST API (the way AutoReact does it)
    if (HTTP && typeof HTTP.post === "function") {
      var ref = { channel_id: channelId, message_id: messageId };
      if (guildId) ref.guild_id = guildId;

      var req = {
        url: API_BASE + "/channels/" + channelId + "/messages",
        body: {
          content: text,
          tts: false,
          flags: 0,
          nonce: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
          message_reference: ref,
          allowed_mentions: { parse: ["users"], replied_user: true }
        }
      };
      var token = getToken();
      if (token) req.headers = { Authorization: token };

      return Promise.resolve(HTTP.post(req)).then(function () {
        dbg("reply sent");
      }).catch(function (e) {
        var status = e && (e.status != null ? e.status : e.message);
        toast("message failed: " + String(status));
      });
    }

    // Fallback: the client's own send function
    if (MessageActions && typeof MessageActions.sendMessage === "function") {
      return Promise.resolve(
        MessageActions.sendMessage(
          channelId,
          { content: text, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
          undefined,
          {
            messageReference: { guild_id: guildId, channel_id: channelId, message_id: messageId },
            allowedMentions: { parse: ["users"], replied_user: true }
          }
        )
      ).catch(function (e) {
        toast("message failed: " + String(e && e.message));
      });
    }

    toast("cannot send: no sender found on this device");
  }

  function handle(payload) {
    if (!payload || payload.type !== "MESSAGE_CREATE" || payload.optimistic) return;
    var message = payload.message;
    if (!message || message.type !== USER_JOIN) return;

    var channelId = payload.channelId || message.channel_id;
    var guildId = guildOf(payload, message, channelId);

    dbg("join message seen");
    if (!guildAllowed(guildId)) {
      dbg("skipped: this server is not enabled in settings");
      return;
    }
    if (!channelId || !message.id) return;
    if (greeted.has(message.id)) return;
    greeted.add(message.id);

    var userId = message.author && message.author.id;
    if (!userId || userId === currentUserId()) return;

    var d = getDelays();
    var delay = d.min + Math.random() * (d.max - d.min);
    var messageId = message.id;
    setTimeout(function () {
      try {
        sendReply(channelId, guildId, messageId);
      } catch (e) {
        toast("send error: " + String(e && e.message));
      }
    }, delay);
  }

  // ---------- Settings screen ----------
  function Settings() {
    useProxy(storage);
    ensureDefaults();

    var h = React.createElement;
    var idCount = getGuildIds().length;

    var children = [];

    // Message editor
    children.push(
      h(
        Forms.FormSection,
        { key: "message", title: "MESSAGE" },
        h(Forms.FormInput, {
          title: "Reply text",
          placeholder: DEFAULT_MESSAGE,
          value: storage.message,
          onChange: function (v) { storage.message = v; },
          keyboardType: "default"
        }),
        h(Forms.FormText, {
          style: { paddingHorizontal: 16, paddingVertical: 8 }
        }, getMessage()
          ? "Sent as a reply to each join message."
          : "No message set, nothing will be sent.")
      )
    );

    var delays = getDelays();
    children.push(
      h(
        Forms.FormSection,
        { key: "delay", title: "DELAY (ms)" },
        h(Forms.FormInput, {
          title: "Minimum delay",
          placeholder: String(DEFAULT_MIN_DELAY),
          value: storage.minDelay,
          onChange: function (v) { storage.minDelay = v; },
          keyboardType: "numeric"
        }),
        h(Forms.FormInput, {
          title: "Maximum delay",
          placeholder: String(DEFAULT_MAX_DELAY),
          value: storage.maxDelay,
          onChange: function (v) { storage.maxDelay = v; },
          keyboardType: "numeric"
        }),
        h(Forms.FormText, {
          style: { paddingHorizontal: 16, paddingVertical: 8 }
        }, "Waits a random time between " + delays.min + " and " + delays.max + " ms before replying.")
      )
    );

    children.push(
      h(
        Forms.FormSection,
        { key: "debug", title: "DEBUG" },
        h(Forms.FormRow, {
          label: "Debug toasts",
          subLabel: "Shows what the plugin is doing. Turn off when it works.",
          trailing: h(Forms.FormSwitch, {
            value: !!storage.debug,
            onValueChange: function (v) { storage.debug = v; }
          })
        })
      )
    );

    // Server chooser
    var serverRows = [];
    serverRows.push(
      h(Forms.FormRow, {
        key: "all",
        label: "Greet in all servers",
        subLabel: "When on, the list below is ignored",
        trailing: h(Forms.FormSwitch, {
          value: !!storage.allGuilds,
          onValueChange: function (v) { storage.allGuilds = v; }
        })
      })
    );

    if (!storage.allGuilds) {
      serverRows.push(
        h(Forms.FormInput, {
          key: "ids",
          title: "Server IDs",
          placeholder: "123456789012345678, 987654321098765432",
          value: storage.guildIds,
          onChange: function (v) { storage.guildIds = v; },
          keyboardType: "default"
        })
      );
      serverRows.push(
        h(Forms.FormText, {
          key: "count",
          style: { paddingHorizontal: 16, paddingVertical: 8 }
        }, idCount
          ? idCount + " valid server ID" + (idCount === 1 ? "" : "s")
          : "No valid server ID. Paste a numeric ID, separate several with commas.")
      );
    }

    children.push(
      h.apply(null, [Forms.FormSection, { key: "servers", title: "SERVERS" }].concat(serverRows))
    );

    return h.apply(null, [RN.ScrollView, null].concat(children));
  }

  // ---------- Plugin lifecycle ----------
  module.exports = {
    onLoad: function () {
      ensureDefaults();
      dbg("loaded (debug build)");

      // Preferred: hook the dispatcher the same way AutoReact does
      if (FD && Array.isArray(FD._interceptors)) {
        interceptFn = function (payload) {
          try {
            handle(payload);
          } catch (e) {
            logger.error("[Auto Welcome Reply] handler error", e);
          }
          return null;
        };
        FD._interceptors.push(interceptFn);
      } else if (FluxDispatcher && FluxDispatcher.subscribe) {
        subscribedFn = function (payload) {
          try {
            handle(payload);
          } catch (e) {
            logger.error("[Auto Welcome Reply] handler error", e);
          }
        };
        FluxDispatcher.subscribe("MESSAGE_CREATE", subscribedFn);
      } else {
        toast("PROBLEM: no way to listen for messages on this device");
      }
    },
    onUnload: function () {
      if (interceptFn && FD && FD._interceptors) {
        FD._interceptors = FD._interceptors.filter(function (f) { return f !== interceptFn; });
        interceptFn = null;
      }
      if (subscribedFn && FluxDispatcher && FluxDispatcher.unsubscribe) {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", subscribedFn);
        subscribedFn = null;
      }
      greeted.clear();
    },
    settings: Settings
  };

  return module.exports;
})();