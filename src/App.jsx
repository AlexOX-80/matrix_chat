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

      const accessToken = client.getAccessToken();
      const homeserver = normalizeHomeserverUrl(client.getHomeserverUrl());
      const parsed = parseMxc(mxcUrl);
      const diagnostics = [];

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

      const uniqueCandidates = [...new Set(candidates.filter(Boolean))];

      for (const url of uniqueCandidates) {
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
          if (canceled) return;
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
          setStatusText("");
          return;
        } catch (err) {
          diagnostics.push(err?.message || "Netzwerkfehler");
        }
      }

      if (!canceled) {
        setSrc("");
        setStatusText(`Bild konnte nicht geladen werden (${diagnostics[diagnostics.length - 1] || "unbekannt"}).`);
      }
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef(null);

  useEffect(() => {
    return () => {
      if (client) {
        client.stopClient();
        client.removeAllListeners();
      }
    };
  }, [client]);

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

      nextClient.on("Room.timeline", (_event, room, toStartOfTimeline) => {
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
      const room = await client.joinRoom(joinInput.trim());
      setJoinInput("");
      refreshRooms(client, false);
      setSelectedRoomId(room.roomId);
    } catch (err) {
      setError(err?.message || "Raum konnte nicht beigetreten werden");
    }
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
          <button className="icon-btn" type="button">☰</button>
          <h1>HabisChat</h1>
        </div>
        <div className="topbar-right">
          <button className="icon-btn" type="button">◻</button>
          <button onClick={logout} type="button">Logout</button>
        </div>
      </header>

      <div className="app-shell">
        <aside className="avatar-rail">
          {rooms.slice(0, 6).map((room) => (
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
            <input placeholder="Search" />
          </div>

          <form className="join-form" onSubmit={joinRoom}>
            <input
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
              placeholder="Raum-ID oder Alias (#raum:server)"
            />
            <button type="submit">Join</button>
          </form>

          <div className="room-list">
            {rooms.map((room) => (
              <button
                key={room.roomId}
                className={room.roomId === selectedRoomId ? "room active" : "room"}
                onClick={() => {
                  setSelectedRoomId(room.roomId);
                  setTimelineTick((x) => x + 1);
                }}
              >
                <span className="room-title">{getRoomName(room)}</span>
                <small>{room.getUnreadNotificationCount() || 0} ungelesen</small>
              </button>
            ))}
            {rooms.length === 0 && <p className="empty">Keine Raeume gefunden.</p>}
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

          <section className="messages">
            {events.map((event) => {
              const content = event.getContent();
              const isImageMessage = content.msgtype === "m.image" || event.getType() === "m.sticker";
              const imageMxc = content.url || content.file?.url || null;
              const isOwn = event.getSender() === session.userId;

              return (
                <article key={event.getId()} className={isOwn ? "message outbound" : "message inbound"}>
                  {!isOwn && <span className="msg-avatar">{getInitials(event.getSender())}</span>}
                  <div className="bubble">
                    {isImageMessage && imageMxc ? (
                      <div className="image-message">
                        <AuthenticatedImage client={client} mxcUrl={imageMxc} alt={content.body || "Bild"} />
                        <p>{content.body || "Bild"}</p>
                      </div>
                    ) : (
                      <p>{content.body || "(Nicht-Text-Nachricht)"}</p>
                    )}
                    <small className="msg-time">{formatTs(event.getTs())}</small>
                  </div>
                </article>
              );
            })}
            {events.length === 0 && <p className="empty">Noch keine Nachrichten.</p>}
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
              ➤
            </button>
          </form>

          {error && <div className="error error-floating">{error}</div>}
        </main>
      </div>
    </div>
  );
}
