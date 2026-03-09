import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "matrix-js-sdk";

const DEFAULT_HOMESERVER = "https://matrix.habis.etke.host";

function formatTs(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getRoomName(room) {
  return room.name || room.getCanonicalAlias() || room.roomId;
}

function getInitials(value) {
  if (!value) return "??";
  const cleaned = value.replace(/^@/, "").split(":")[0].trim();
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return cleaned.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function normalizeHomeserverUrl(input) {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Bitte eine Homeserver-URL eingeben.");
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withProtocol);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Homeserver-URL muss mit http:// oder https:// beginnen.");
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function getImageDimensions(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({});
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function parseMxc(mxcUrl) {
  if (!mxcUrl || typeof mxcUrl !== "string" || !mxcUrl.startsWith("mxc://")) return null;
  const rest = mxcUrl.slice(6);
  const idx = rest.indexOf("/");
  if (idx < 1) return null;
  return {
    server: rest.slice(0, idx),
    mediaId: rest.slice(idx + 1),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedText({ text, query }) {
  if (!query || !text) return <>{text || ""}</>;
  const regex = new RegExp(`(${escapeRegExp(query)})`, "ig");
  const parts = String(text).split(regex);
  return (
    <>
      {parts.map((part, idx) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={`${part}-${idx}`} className="search-mark">{part}</mark>
        ) : (
          <span key={`${part}-${idx}`}>{part}</span>
        )
      )}
    </>
  );
}

function RichTextMessage({ text, query }) {
  const value = String(text || "");
  const urlRegex = /((?:https?:\/\/|www\.)[^\s<]+)/gi;
  const parts = value.split(urlRegex);

  function parseUrlToken(token) {
    let core = token;
    let suffix = "";
    while (/[),.;!?]$/.test(core)) {
      suffix = core.slice(-1) + suffix;
      core = core.slice(0, -1);
    }
    return { core, suffix };
  }

  return (
    <>
      {parts.map((part, idx) => {
        const isUrl = /^(?:https?:\/\/|www\.)/i.test(part);
        if (!isUrl) {
          return <HighlightedText key={`t-${idx}`} text={part} query={query} />;
        }

        const { core, suffix } = parseUrlToken(part);
        const href = /^https?:\/\//i.test(core) ? core : `https://${core}`;
        return (
          <span key={`u-${idx}`}>
            <a className="msg-link" href={href} target="_blank" rel="noreferrer">
              <HighlightedText text={core} query={query} />
            </a>
            {suffix}
          </span>
        );
      })}
    </>
  );
}

function getMediaCandidates(client, mxcUrl) {
  if (!client || !mxcUrl) return [];

  const homeserver = normalizeHomeserverUrl(client.getHomeserverUrl());
  const parsed = parseMxc(mxcUrl);
  const candidates = [
    client.mxcUrlToHttp(mxcUrl, 900, 700, "scale", false, true, true),
    client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, true, true),
  ];

  if (parsed) {
    const s = encodeURIComponent(parsed.server);
    const m = encodeURIComponent(parsed.mediaId);
    candidates.push(`${homeserver}/_matrix/client/v1/media/thumbnail/${s}/${m}?width=900&height=700&method=scale`);
    candidates.push(`${homeserver}/_matrix/client/v1/media/download/${s}/${m}`);
    candidates.push(`${homeserver}/_matrix/media/v3/thumbnail/${s}/${m}?width=900&height=700&method=scale`);
    candidates.push(`${homeserver}/_matrix/media/v3/download/${s}/${m}`);
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function fetchMxcBlobUrl(client, mxcUrl, fallbackText) {
  const accessToken = client.getAccessToken();
  const diagnostics = [];
  const candidates = getMediaCandidates(client, mxcUrl);

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        redirect: "follow",
      });
      if (!response.ok) {
        diagnostics.push(`${response.status} ${response.statusText}`);
        continue;
      }
      const blob = await response.blob();
      return { blobUrl: URL.createObjectURL(blob), statusText: "" };
    } catch (err) {
      diagnostics.push(err?.message || "Netzwerkfehler");
    }
  }

  return {
    blobUrl: "",
    statusText: `${fallbackText} (${diagnostics[diagnostics.length - 1] || "unbekannt"}).`,
  };
}

function AuthenticatedImage({ client, mxcUrl, alt }) {
  const [src, setSrc] = useState("");
  const [statusText, setStatusText] = useState("Bild wird geladen...");

  useEffect(() => {
    let canceled = false;
    let objectUrl = "";

    async function load() {
      if (!client || !mxcUrl) {
        setStatusText("Keine Bild-URL gefunden.");
        setSrc("");
        return;
      }

      const result = await fetchMxcBlobUrl(client, mxcUrl, "Bild konnte nicht geladen werden");
      if (canceled) return;
      objectUrl = result.blobUrl;
      setSrc(result.blobUrl);
      setStatusText(result.statusText);
    }

    setStatusText("Bild wird geladen...");
    setSrc("");
    load();

    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, mxcUrl]);

  if (!src) return <p className="image-loading">{statusText}</p>;
  return <img src={src} alt={alt} loading="lazy" />;
}

function AuthenticatedPdf({ client, mxcUrl, filename }) {
  const [src, setSrc] = useState("");
  const [statusText, setStatusText] = useState("PDF wird geladen...");

  useEffect(() => {
    let canceled = false;
    let objectUrl = "";

    async function load() {
      if (!client || !mxcUrl) {
        setStatusText("Keine PDF-URL gefunden.");
        setSrc("");
        return;
      }

      const result = await fetchMxcBlobUrl(client, mxcUrl, "PDF konnte nicht geladen werden");
      if (canceled) return;
      objectUrl = result.blobUrl;
      setSrc(result.blobUrl);
      setStatusText(result.statusText);
    }

    setStatusText("PDF wird geladen...");
    setSrc("");
    load();

    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, mxcUrl]);

  if (!src) return <p className="image-loading">{statusText}</p>;

  return (
    <div className="pdf-message">
      <iframe title={filename || "PDF Vorschau"} src={src} />
      <a href={src} target="_blank" rel="noreferrer">PDF im neuen Tab oeffnen</a>
    </div>
  );
}

export default function App() {
  const [homeserver, setHomeserver] = useState(DEFAULT_HOMESERVER);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [client, setClient] = useState(null);
  const [session, setSession] = useState(null);
  const [syncState, setSyncState] = useState("DISCONNECTED");

  const [rooms, setRooms] = useState([]);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [timelineTick, setTimelineTick] = useState(0);
  const selectedRoomIdRef = useRef("");

  const [message, setMessage] = useState("");
  const [joinInput, setJoinInput] = useState("");
  const [joinSuggestions, setJoinSuggestions] = useState([]);
  const [searchingJoinTargets, setSearchingJoinTargets] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef(null);
  const messagesRef = useRef(null);
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    return () => {
      if (client) {
        client.stopClient();
        client.removeAllListeners();
      }
      if (ttsSupported) window.speechSynthesis.cancel();
    };
  }, [client, ttsSupported]);

  useEffect(() => {
    selectedRoomIdRef.current = selectedRoomId;
  }, [selectedRoomId]);

  const selectedRoom = useMemo(
    () => rooms.find((r) => r.roomId === selectedRoomId) || null,
    [rooms, selectedRoomId]
  );

  const events = useMemo(() => {
    if (!selectedRoom) return [];
    return selectedRoom
      .getLiveTimeline()
      .getEvents()
      .filter((e) => e.getType() === "m.room.message");
  }, [selectedRoom, rooms, timelineTick]);

  const searchQuery = chatSearch.trim().toLowerCase();

  const roomMessageHitCountById = useMemo(() => {
    if (!searchQuery) return new Map();
    const map = new Map();
    for (const room of rooms) {
      const hits = room
        .getLiveTimeline()
        .getEvents()
        .reduce((count, e) => {
          if (e.getType() !== "m.room.message") return count;
          const body = (e.getContent()?.body || "").toLowerCase();
          return body.includes(searchQuery) ? count + 1 : count;
        }, 0);
      map.set(room.roomId, hits);
    }
    return map;
  }, [rooms, searchQuery]);

  const filteredRooms = useMemo(() => {
    if (!searchQuery) return rooms;

    return rooms.filter((room) => {
      const name = getRoomName(room).toLowerCase().includes(searchQuery);
      if (name) return true;

      const memberMatch = room
        .getMembers()
        .some((m) =>
          `${m.name || ""} ${m.userId || ""}`.toLowerCase().includes(searchQuery)
        );
      if (memberMatch) return true;

      return (roomMessageHitCountById.get(room.roomId) || 0) > 0;
    });
  }, [rooms, searchQuery, roomMessageHitCountById]);

  const filteredEvents = useMemo(() => {
    if (!searchQuery) return events;
    return events.filter((event) => {
      const content = event.getContent();
      const body = (content?.body || "").toLowerCase();
      const sender = (event.getSender() || "").toLowerCase();
      return body.includes(searchQuery) || sender.includes(searchQuery);
    });
  }, [events, searchQuery]);

  useEffect(() => {
    if (!client) return;
    const query = joinInput.trim();
    if (!query || query.length < 2) {
      setJoinSuggestions([]);
      setSearchingJoinTargets(false);
      return;
    }

    let canceled = false;
    const timeoutId = setTimeout(async () => {
      setSearchingJoinTargets(true);
      const suggestions = [];

      try {
        const lower = query.toLowerCase();

        for (const room of rooms) {
          const roomName = getRoomName(room);
          const haystack = `${roomName} ${room.roomId} ${room.getCanonicalAlias() || ""}`.toLowerCase();
          if (haystack.includes(lower)) {
            suggestions.push({
              key: `local-room-${room.roomId}`,
              type: "room",
              target: room.roomId,
              label: roomName,
              subtitle: room.roomId,
            });
          }
          if (suggestions.length >= 6) break;
        }

        try {
          const pub = await client.publicRooms({
            limit: 8,
            filter: { generic_search_term: query },
          });

          for (const r of pub?.chunk || []) {
            const target = r.canonical_alias || r.room_id;
            if (!target) continue;
            const key = `pub-room-${r.room_id}`;
            if (suggestions.some((s) => s.key === key)) continue;
            suggestions.push({
              key,
              type: "room",
              target,
              label: r.name || r.canonical_alias || r.room_id,
              subtitle: r.canonical_alias || r.room_id,
            });
          }
        } catch {
          // Public room directory can be disabled; ignore.
        }

        try {
          const users = await client.searchUserDirectory({ term: query, limit: 8 });
          for (const u of users?.results || []) {
            if (!u.user_id) continue;
            suggestions.push({
              key: `user-${u.user_id}`,
              type: "user",
              target: u.user_id,
              label: u.display_name || u.user_id,
              subtitle: u.user_id,
            });
          }
        } catch {
          // User directory search may be restricted.
        }
      } finally {
        if (!canceled) {
          const unique = [];
          const seen = new Set();
          for (const item of suggestions) {
            const dedupeKey = `${item.type}:${item.target}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            unique.push(item);
          }
          setJoinSuggestions(unique.slice(0, 12));
          setSearchingJoinTargets(false);
        }
      }
    }, 260);

    return () => {
      canceled = true;
      clearTimeout(timeoutId);
    };
  }, [client, joinInput, rooms]);

  function getLastTimelineMessageEvent(room) {
    if (!room) return null;
    const all = room.getLiveTimeline().getEvents();
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const e = all[i];
      if (e.getType() === "m.room.message" && e.getId()) return e;
    }
    return null;
  }

  async function markRoomAsRead(room = selectedRoom) {
    if (!client || !room) return;
    const lastEvent = getLastTimelineMessageEvent(room);
    if (!lastEvent) return;
    try {
      await client.sendReadReceipt(lastEvent);
      refreshRooms(client);
    } catch {
      // Ignore receipt errors in prototype mode.
    }
  }

  useEffect(() => {
    markRoomAsRead(selectedRoom);
  }, [selectedRoomId, timelineTick]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;

    let timeoutId = null;
    const onScroll = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (remaining <= 24) {
          markRoomAsRead(selectedRoom);
        }
      }, 120);
    };

    el.addEventListener("scroll", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [selectedRoomId, selectedRoom, timelineTick, client]);

  function refreshRooms(nextClient, keepSelection = true) {
    const nextRooms = [...nextClient.getRooms()].sort(
      (a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp()
    );
    setRooms(nextRooms);
    const currentSelectedRoomId = selectedRoomIdRef.current;

    if (nextRooms.length === 0) {
      setSelectedRoomId("");
      return;
    }

    if (keepSelection && nextRooms.some((r) => r.roomId === currentSelectedRoomId)) {
      return;
    }

    if (currentSelectedRoomId !== nextRooms[0].roomId) {
      setSelectedRoomId(nextRooms[0].roomId);
    }
  }

  function speakText(text) {
    if (!ttsSupported || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "de-DE";
    window.speechSynthesis.speak(utterance);
  }

  async function login(event) {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      const baseUrl = normalizeHomeserverUrl(homeserver);
      setHomeserver(baseUrl);

      const authClient = createClient({ baseUrl });
      const response = await authClient.login("m.login.password", {
        identifier: { type: "m.id.user", user: username.trim() },
        password,
        initial_device_display_name: "Matrix React Prototype",
      });

      const nextClient = createClient({
        baseUrl,
        accessToken: response.access_token,
        userId: response.user_id,
        deviceId: response.device_id,
      });

      nextClient.on("sync", (state) => {
        setSyncState(state);
        refreshRooms(nextClient);
      });

      nextClient.on("Room", () => refreshRooms(nextClient));

      nextClient.on("Room.timeline", (matrixEvent, room, toStartOfTimeline) => {
        if (toStartOfTimeline) return;
        if (room?.roomId === selectedRoomIdRef.current) {
          setTimelineTick((x) => x + 1);
        }
        refreshRooms(nextClient);
      });

      await nextClient.startClient({ initialSyncLimit: 30 });

      setClient(nextClient);
      setSession({
        userId: response.user_id,
        accessToken: response.access_token,
      });
      setSyncState("SYNCING");
    } catch (err) {
      setError(err?.message || "Login fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!client || !selectedRoomId || !message.trim()) return;

    try {
      await client.sendEvent(selectedRoomId, "m.room.message", {
        msgtype: "m.text",
        body: message.trim(),
      });
      setMessage("");
      setTimelineTick((x) => x + 1);
    } catch (err) {
      setError(err?.message || "Nachricht konnte nicht gesendet werden");
    }
  }

  async function sendImage(event) {
    const file = event.target.files?.[0];
    if (!file || !client || !selectedRoomId) return;

    try {
      setError("");
      setUploadingImage(true);

      if (!file.type?.startsWith("image/")) {
        throw new Error("Bitte eine Bilddatei auswaehlen.");
      }

      const dimensions = await getImageDimensions(file);
      const uploadResponse = await client.uploadContent(file, {
        includeFilename: true,
        name: file.name,
        type: file.type || "application/octet-stream",
      });

      const contentUri =
        typeof uploadResponse === "string" ? uploadResponse : uploadResponse?.content_uri;

      if (!contentUri) {
        throw new Error("Upload fehlgeschlagen: Keine content_uri erhalten.");
      }

      await client.sendEvent(selectedRoomId, "m.room.message", {
        msgtype: "m.image",
        body: file.name,
        url: contentUri,
        info: {
          mimetype: file.type,
          size: file.size,
          ...dimensions,
        },
      });

      setTimelineTick((x) => x + 1);
    } catch (err) {
      setError(err?.message || "Bild konnte nicht gesendet werden");
    } finally {
      setUploadingImage(false);
      if (imageInputRef.current) {
        imageInputRef.current.value = "";
      }
    }
  }

  async function joinRoom(event) {
    event.preventDefault();
    if (!client || !joinInput.trim()) return;

    try {
      await handleJoinTarget(joinInput.trim());
    } catch (err) {
      setError(err?.message || "Raum konnte nicht beigetreten werden");
    }
  }

  async function handleJoinTarget(target, explicitType) {
    if (!client || !target) return;
    const trimmed = target.trim();
    const type = explicitType || (trimmed.startsWith("@") ? "user" : "room");

    if (type === "user") {
      const created = await client.createRoom({
        is_direct: true,
        invite: [trimmed],
      });
      setJoinInput("");
      setJoinSuggestions([]);
      refreshRooms(client, false);
      setSelectedRoomId(created.room_id);
      return;
    }

    const room = await client.joinRoom(trimmed);
    setJoinInput("");
    setJoinSuggestions([]);
    refreshRooms(client, false);
    setSelectedRoomId(room.roomId);
  }

  function logout() {
    if (client) {
      client.stopClient();
      client.removeAllListeners();
    }

    setClient(null);
    setSession(null);
    setRooms([]);
    setSelectedRoomId("");
    setTimelineTick(0);
    setSyncState("DISCONNECTED");
    setError("");
    if (ttsSupported) {
      window.speechSynthesis.cancel();
    }
  }

  if (!session) {
    return (
      <div className="login-shell">
        <form className="login-card" onSubmit={login}>
          <h1>Matrix Prototype</h1>
          <p>Schneller React-Client mit Passwort-Login.</p>

          <label>
            Homeserver URL
            <input
              value={homeserver}
              onChange={(e) => setHomeserver(e.target.value)}
              placeholder="https://matrix.org"
              required
            />
          </label>

          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="@name:server.tld oder name"
              required
            />
          </label>

          <label>
            Passwort
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {error && <div className="error">{error}</div>}

          <button type="submit" disabled={busy}>
            {busy ? "Login..." : "Einloggen"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="app-frame">
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-btn" type="button">Menu</button>
          <h1>HabisChat</h1>
        </div>
        <div className="topbar-right">
          <button onClick={logout} type="button">Logout</button>
        </div>
      </header>

      <div className="app-shell">
        <aside className="avatar-rail">
          {filteredRooms.slice(0, 6).map((room) => (
            <button
              key={`rail-${room.roomId}`}
              type="button"
              className={room.roomId === selectedRoomId ? "rail-avatar active" : "rail-avatar"}
              onClick={() => setSelectedRoomId(room.roomId)}
            >
              {getInitials(getRoomName(room))}
            </button>
          ))}
        </aside>

        <aside className="sidebar">
          <div className="sidebar-header">
            <div>
              <strong>{session.userId}</strong>
              <small>Status: {syncState}</small>
            </div>
            <input
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              placeholder="Chats, Kontakte, Nachrichten..."
            />
          </div>

          <form className="join-form" onSubmit={joinRoom}>
            <input
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
              placeholder="Raum-ID, Alias oder User (@name:server)"
            />
            <button type="submit">Join</button>
          </form>
          {(searchingJoinTargets || joinSuggestions.length > 0) && (
            <div className="join-suggestions">
              {searchingJoinTargets && <div className="join-suggestion-meta">Suche...</div>}
              {joinSuggestions.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className="join-suggestion"
                  onClick={() => handleJoinTarget(entry.target, entry.type)}
                >
                  <span>{entry.type === "user" ? "User" : "Raum"}: {entry.label}</span>
                  <small>{entry.subtitle}</small>
                </button>
              ))}
            </div>
          )}

          <div className="room-list">
            {filteredRooms.map((room) => (
              <button
                key={room.roomId}
                className={room.roomId === selectedRoomId ? "room active" : "room"}
                onClick={() => {
                  setSelectedRoomId(room.roomId);
                  setTimelineTick((x) => x + 1);
                }}
              >
                <span className="room-title">
                  <HighlightedText text={getRoomName(room)} query={searchQuery} />
                </span>
                <small>
                  {searchQuery
                    ? `${roomMessageHitCountById.get(room.roomId) || 0} Treffer`
                    : `${room.getUnreadNotificationCount() || 0} ungelesen`}
                </small>
              </button>
            ))}
            {rooms.length === 0 && <p className="empty">Keine Raeume gefunden.</p>}
            {rooms.length > 0 && filteredRooms.length === 0 && (
              <p className="empty">Keine Treffer fuer "{chatSearch}".</p>
            )}
          </div>
        </aside>

        <main className="chat-panel">
          <header>
            <div className="chat-peer">
              <span className="chat-avatar">
                {getInitials(selectedRoom ? getRoomName(selectedRoom) : session.userId)}
              </span>
              <div>
                <h2>{selectedRoom ? getRoomName(selectedRoom) : "Kein Raum gewaehlt"}</h2>
                <small>Online</small>
              </div>
            </div>
            <div className="chat-actions">
              <button type="button" className="dot-btn" />
              <button type="button" className="dot-btn" />
            </div>
          </header>

          <section ref={messagesRef} className="messages">
            {filteredEvents.map((event) => {
              const content = event.getContent();
              const isImageMessage = content.msgtype === "m.image" || event.getType() === "m.sticker";
              const imageMxc = content.url || content.file?.url || null;
              const isPdfMessage =
                content.msgtype === "m.file" &&
                ((content.info?.mimetype || "").toLowerCase().includes("application/pdf") ||
                  (content.body || "").toLowerCase().endsWith(".pdf"));
              const isOwn = event.getSender() === session.userId;
              const isTextMessage = content.msgtype === "m.text" && Boolean(content.body);

              return (
                <article key={event.getId()} className={isOwn ? "message outbound" : "message inbound"}>
                  {!isOwn && <span className="msg-avatar">{getInitials(event.getSender())}</span>}
                  {isTextMessage && (
                    <button
                      type="button"
                      className="speak-btn"
                      onClick={() => speakText(content.body)}
                      disabled={!ttsSupported}
                      title={ttsSupported ? "Diese Nachricht vorlesen" : "Browser unterstuetzt kein Vorlesen"}
                      aria-label="Nachricht vorlesen"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                        <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                      </svg>
                    </button>
                  )}
                  <div className="bubble">
                    {isImageMessage && imageMxc ? (
                      <div className="image-message">
                        <AuthenticatedImage client={client} mxcUrl={imageMxc} alt={content.body || "Bild"} />
                        <p>{content.body || "Bild"}</p>
                      </div>
                    ) : isPdfMessage && imageMxc ? (
                      <div className="pdf-wrap">
                        <AuthenticatedPdf client={client} mxcUrl={imageMxc} filename={content.body} />
                      </div>
                    ) : (
                      <p>
                        <RichTextMessage text={content.body || "(Nicht-Text-Nachricht)"} query={searchQuery} />
                      </p>
                    )}
                    <small className="msg-time">{formatTs(event.getTs())}</small>
                  </div>
                </article>
              );
            })}
            {events.length === 0 && <p className="empty">Noch keine Nachrichten.</p>}
            {events.length > 0 && filteredEvents.length === 0 && searchQuery && (
              <p className="empty">Keine Nachrichten-Treffer fuer "{chatSearch}".</p>
            )}
          </section>

          <form className="composer" onSubmit={sendMessage}>
            <label className={!selectedRoomId || uploadingImage ? "image-upload disabled" : "image-upload"}>
              +
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                onChange={sendImage}
                disabled={!selectedRoomId || uploadingImage}
              />
            </label>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Nachricht schreiben..."
              disabled={!selectedRoomId}
            />
            <button type="submit" disabled={!selectedRoomId}>
              Send
            </button>
          </form>

          {error && <div className="error error-floating">{error}</div>}
        </main>
      </div>
    </div>
  );
}
