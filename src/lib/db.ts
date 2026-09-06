// ---------------------------------------------------------------------------
// Bază de date SQLite (node:sqlite — nativ în Node 22.5+, zero dependențe)
// Un singur fișier: /opt/faikkitbox/data/faikkitbox.db
// ---------------------------------------------------------------------------

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hashPassword } from "./auth/password";

function dbPath(): string {
  return process.env.FAIKKITBOX_DB_PATH ?? "/opt/faikkitbox/data/faikkitbox.db";
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;

  const file = dbPath();
  mkdirSync(dirname(file), { recursive: true });

  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp DESC);

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      category INTEGER NOT NULL DEFAULT 0,
      category_name TEXT NOT NULL DEFAULT '',
      freeleech INTEGER NOT NULL DEFAULT 0,
      internal INTEGER NOT NULL DEFAULT 0,
      save_path TEXT NOT NULL DEFAULT '',
      downloaded_at TEXT NOT NULL,
      completed_at TEXT,
      torrent_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_downloads_downloaded_at ON downloads(downloaded_at DESC);

    CREATE TABLE IF NOT EXISTS commits (
      sha TEXT PRIMARY KEY,
      short_sha TEXT NOT NULL,
      message TEXT NOT NULL,
      author TEXT NOT NULL,
      date TEXT NOT NULL,
      url TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date DESC);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS speedtest_history (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      download REAL NOT NULL,
      upload REAL NOT NULL,
      ping REAL NOT NULL,
      jitter REAL,
      isp TEXT,
      server_name TEXT,
      result_url TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_speedtest_ts ON speedtest_history(timestamp DESC);

    CREATE TABLE IF NOT EXISTS plex_active_sessions (
      key TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      last_view_offset_ms INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      user TEXT NOT NULL,
      title TEXT NOT NULL,
      grandparent_title TEXT,
      rating_key TEXT
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_error_log_timestamp ON error_log(timestamp DESC);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      plex_account_id INTEGER,
      plex_username TEXT,
      plex_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      logged_in_at TEXT NOT NULL DEFAULT (datetime('now')),
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_logins_user ON user_logins(user_id, logged_in_at DESC);

    -- Sursă unică pentru datele unui titlu media (film/serial/episod), ca
    -- Bibliotecă/Lansări să nu mai reconstituie prin căutări TMDB live ce
    -- oricum se știe deja din momentul în care titlul a fost adăugat.
    -- 'tv_show' e un rând-părinte doar cu metadate (fără torrent propriu);
    -- episoadele efectiv descărcate ale unui serial ating de el prin
    -- parent_id, ca genul/descrierea să nu se repete per episod.
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type TEXT NOT NULL CHECK(media_type IN ('movie','tv_show','episode')),
      parent_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
      imdb_id TEXT,
      tmdb_id INTEGER,
      title TEXT NOT NULL,
      original_title TEXT,
      literal_title TEXT,
      year INTEGER,
      season INTEGER,
      episode INTEGER,
      overview_ro TEXT,
      genres TEXT NOT NULL DEFAULT '[]',
      poster_path TEXT,
      tv_status TEXT,
      plex_rating_key TEXT,
      plex_added_at INTEGER,
      torrent_name TEXT,
      torrent_hash TEXT,
      category INTEGER,
      category_name TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      freeleech INTEGER NOT NULL DEFAULT 0,
      internal INTEGER NOT NULL DEFAULT 0,
      save_path TEXT,
      is_season_pack INTEGER NOT NULL DEFAULT 0,
      added_via TEXT,
      requested_by_user_id INTEGER,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      has_romanian_subtitle INTEGER NOT NULL DEFAULT 0,
      has_romanian_audio INTEGER NOT NULL DEFAULT 0,
      subtitle_source TEXT,
      subtitle_detail TEXT,
      subtitle_checked_at TEXT,
      quality TEXT,
      duration_ms INTEGER,
      -- Titlul episodului (doar pe rândurile 'episode'): coloana title ține
      -- titlul SERIALULUI și pe rândurile de episod, deci numele episodului
      -- n-avea unde sta. Se completează din TMDB, o dată, de
      -- fillMissingEpisodeTitles — nu se cere live la fiecare deschidere de
      -- drawer, ca Biblioteca să rămână doar SELECT-uri.
      episode_title TEXT,
      -- Urmărire episoade noi — au sens DOAR pe rândul-părinte 'tv_show'.
      -- Stau aici, pe rândul serialului, nu într-o tabelă separată: prima
      -- implementare (pinned_items, ștearsă în v14) ținea urmărirea într-o
      -- structură paralelă, legată de 'media' doar prin tmdb_id, și de-acolo
      -- veneau toate bug-urile ei (rânduri duplicate, dedublare între două
      -- liste, descărcare de N ori pentru N useri care fixaseră același
      -- titlu). Rândul 'tv_show' e deja unic per serial și deja legat de
      -- episoade prin parent_id — e locul corect.
      auto_download INTEGER NOT NULL DEFAULT 0,
      auto_download_quality TEXT,
      -- Prima poziție de la care se descarcă ('S03E05'): activarea urmăririi
      -- nu trebuie să tragă retroactiv tot ce lipsește din istoricul unui
      -- serial cu 7 sezoane din care ai 2.
      auto_download_from TEXT,
      watch_last_checked_at TEXT,
      -- Metadate de serial reîmprospătate periodic din TMDB (vezi
      -- refreshShowMetadata). tv_status era scris o singură dată, la prima
      -- descărcare, și rămânea așa pe veci: un serial încheiat continua să
      -- ofere urmărirea, iar unul reînnoit după ce fusese marcat 'Ended'
      -- nu mai arăta niciodată butonul, fiindcă panoul se ascunde exact pe
      -- valoarea asta.
      next_episode TEXT,
      -- Data de la TMDB ("2026-09-13", fără oră) și, separat, instantul exact
      -- de la TVmaze ("2026-09-13T01:00:00+00:00") — TMDB nu dă ora. Coloane
      -- distincte, nu una singură cu două înțelesuri: airstamp lipsește
      -- adesea (serial necunoscut de TVmaze), iar atunci tot vrem data.
      next_episode_air_date TEXT,
      next_episode_airstamp TEXT,
      meta_refreshed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_media_imdb ON media(imdb_id);
    CREATE INDEX IF NOT EXISTS idx_media_parent ON media(parent_id);
    CREATE INDEX IF NOT EXISTS idx_media_torrent_hash ON media(torrent_hash) WHERE torrent_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_plex_key ON media(plex_rating_key) WHERE plex_rating_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS recent_watch_cache (
      plex_rating_key TEXT NOT NULL,
      username TEXT NOT NULL,
      title TEXT NOT NULL,
      show TEXT,
      season INTEGER,
      episode INTEGER,
      poster_path TEXT,
      viewed_at INTEGER NOT NULL,
      view_offset_ms INTEGER,
      duration_ms INTEGER,
      completed INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (plex_rating_key, username)
    );
    CREATE INDEX IF NOT EXISTS idx_recent_watch_cache_viewed_at ON recent_watch_cache(viewed_at DESC);

    -- Starea rulării curente (o singură linie, id = 1). Există ca să putem
    -- detecta opririle pe care procesul NU apucă să le logheze el însuși:
    -- SIGKILL de la systemd, OOM kill, pană de curent. La oprirea curată
    -- punem clean_shutdown = 1; dacă la pornire găsim 0, rularea anterioară
    -- s-a terminat brutal, iar last_heartbeat ne dă momentul aproximativ.
    CREATE TABLE IF NOT EXISTS server_runtime (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      started_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL,
      clean_shutdown INTEGER NOT NULL DEFAULT 0,
      pid INTEGER
    );
  `);

  // Curățări one-time, versionate cu PRAGMA user_version
  runCleanups(db);

  return db;
}

function runCleanups(database: DatabaseSync): void {
  // Migrările rulează într-o tranzacție: mai multe dintre ele fac secvențe
  // CREATE -> INSERT -> DROP -> RENAME (v9 recreează pinned_items), iar o
  // întrerupere la mijloc lăsa baza cu două tabele și fără cea originală.
  //
  // Eșecul e fatal, intenționat: înainte, tot blocul era învelit într-un
  // try/catch care doar scria un console.warn, deci o migrare picată la
  // jumătate nu incrementa user_version, dar aplicația pornea oricum — cu
  // schemă parțială și fără ca nimeni să observe. Mai bine refuză să pornească.
  database.exec("BEGIN");
  try {
    applyCleanups(database);
    database.exec("COMMIT");
  } catch (e) {
    database.exec("ROLLBACK");
    console.error("[db] Migrare eșuată — pornirea e oprită:", e);
    throw e;
  }
}

function applyCleanups(database: DatabaseSync): void {
  {
    const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const version = row?.user_version ?? 0;

    if (version < 1) {
      // v1: elimină duplicatele server_start (păstrează unul per minut)
      const result = database
        .prepare(
          `
        DELETE FROM activity
        WHERE type = 'server_start'
          AND id NOT IN (
            SELECT MIN(id) FROM activity
            WHERE type = 'server_start'
            GROUP BY substr(timestamp, 1, 16)
          )
      `,
        )
        .run();
      console.log(`[db] Curățare v1: eliminate ${result.changes} duplicate server_start`);
      database.exec("PRAGMA user_version = 1");
    }

    if (version < 2) {
      // v2: adaugă coloana watch_filelist_season la pinned_watch_settings (dacă nu există)
      try {
        database.exec(
          "ALTER TABLE pinned_watch_settings ADD COLUMN watch_filelist_season INTEGER NOT NULL DEFAULT 0",
        );
        console.log("[db] Migrare v2: adăugat watch_filelist_season");
      } catch {
        // coloana există deja — ignorăm
      }
      database.exec("PRAGMA user_version = 2");
    }

    if (version < 3) {
      try {
        database.exec(
          "ALTER TABLE pinned_watch_settings ADD COLUMN auto_download INTEGER NOT NULL DEFAULT 0",
        );
        console.log("[db] Migrare v3: adăugat auto_download");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      try {
        database.exec(
          "ALTER TABLE pinned_watch_settings ADD COLUMN auto_download_quality TEXT NOT NULL DEFAULT '1080p'",
        );
        console.log("[db] Migrare v3: adăugat auto_download_quality");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      database.exec("PRAGMA user_version = 3");
    }

    if (version < 4) {
      // v4: error_log capătă grupare (count/last_seen) și nivel (warn/error)
      try {
        database.exec("ALTER TABLE error_log ADD COLUMN level TEXT NOT NULL DEFAULT 'error'");
        console.log("[db] Migrare v4: adăugat error_log.level");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      try {
        database.exec("ALTER TABLE error_log ADD COLUMN count INTEGER NOT NULL DEFAULT 1");
        console.log("[db] Migrare v4: adăugat error_log.count");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      try {
        database.exec("ALTER TABLE error_log ADD COLUMN last_seen TEXT");
        database.exec("UPDATE error_log SET last_seen = timestamp WHERE last_seen IS NULL");
        console.log("[db] Migrare v4: adăugat error_log.last_seen");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      try {
        database.exec(
          "CREATE INDEX IF NOT EXISTS idx_error_log_group ON error_log(source, level, message)",
        );
      } catch {
        // există deja
      }
      database.exec("PRAGMA user_version = 4");
    }

    if (version < 5) {
      // v5: downloads capătă coloana imdb — folosită pentru potrivirea
      // subtitrărilor OpenSubtitles la finalul descărcării
      try {
        database.exec("ALTER TABLE downloads ADD COLUMN imdb TEXT");
        console.log("[db] Migrare v5: adăugat downloads.imdb");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      database.exec("PRAGMA user_version = 5");
    }

    if (version < 6) {
      // v6: elimină watch_plex (pinned_watch_settings) și plex_episode_keys/
      // plex_movie_found (pinned_watch_state) — funcția "apariție în Plex" a
      // fost eliminată din aplicație (scenariu inexistent în fluxul real de
      // lucru, tot ce ajunge în Plex trece deja prin Filelist).
      try {
        database.exec("ALTER TABLE pinned_watch_settings DROP COLUMN watch_plex");
        console.log("[db] Migrare v6: eliminat pinned_watch_settings.watch_plex");
      } catch {
        // coloana nu există (deja eliminată sau tabel nou)
      }
      try {
        database.exec("ALTER TABLE pinned_watch_state DROP COLUMN plex_episode_keys");
        console.log("[db] Migrare v6: eliminat pinned_watch_state.plex_episode_keys");
      } catch {
        // coloana nu există
      }
      try {
        database.exec("ALTER TABLE pinned_watch_state DROP COLUMN plex_movie_found");
        console.log("[db] Migrare v6: eliminat pinned_watch_state.plex_movie_found");
      } catch {
        // coloana nu există
      }
      database.exec("PRAGMA user_version = 6");
    }

    if (version < 7) {
      // v7: conturile de admin trec din variabile de mediu (ADMIN_USER /
      // ADMIN_PASS) în DB, cu suport pentru mai multe conturi. La prima
      // rulare după migrare, dacă tabela e goală și env vars sunt setate,
      // contul existent e migrat automat — ca să nu rămână nimeni blocat
      // afară. După asta, gestionarea se face din UI (Tehnic).
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
        const count = database.prepare("SELECT COUNT(*) as c FROM admin_users").get() as {
          c: number;
        };
        const envUser = process.env.ADMIN_USER;
        const envPass = process.env.ADMIN_PASS;
        if (count.c === 0 && envUser && envPass) {
          database
            .prepare("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)")
            .run(envUser, hashPassword(envPass));
          console.log(`[db] Migrare v7: cont admin migrat din .env → DB ("${envUser}")`);
        }
      } catch (e) {
        console.warn("[db] Migrare v7 eșuată:", e);
      }
      database.exec("PRAGMA user_version = 7");
    }

    if (version < 8) {
      // v8: admin_users e înlocuit de tabela unificată users (role +
      // status), care va găzdui și utilizatorii obișnuiți înregistrați
      // public, cu aprobare manuală și legătură de cont Plex. Conturile
      // admin existente devin role='admin', status='approved' (deja
      // validate — nu au nevoie de aprobare).
      try {
        database.exec(
          `INSERT INTO users (username, password_hash, role, status, created_at)
           SELECT username, password_hash, 'admin', 'approved', created_at FROM admin_users
           WHERE username NOT IN (SELECT username FROM users)`,
        );
        database.exec("DROP TABLE IF EXISTS admin_users");
        console.log("[db] Migrare v8: admin_users → users (role=admin, status=approved)");
      } catch (e) {
        console.warn("[db] Migrare v8 eșuată:", e);
      }
      database.exec("PRAGMA user_version = 8");
    }

    if (version < 9) {
      // v9: pinned_items devine per-utilizator (fiecare user vede/gestionează
      // propria listă de fixări în Lansări), dar pinned_watch_settings și
      // pinned_watch_state rămân globale per titlu (id, media_type) — dacă
      // doi useri fixează același film, verificarea/auto-download-ul rulează
      // o singură dată pentru acel titlu, nu duplicat per user.
      try {
        const cols = database.prepare("PRAGMA table_info(pinned_items)").all() as Array<{
          name: string;
        }>;
        // Pe o bază NOUĂ, pinned_items nu există deloc (v14 a eliminat funcția,
        // deci blocul de schemă n-o mai creează). Fără verificarea asta, v9
        // pornea oricum, crea pinned_items_new, apoi pica la INSERT ... FROM
        // pinned_items — iar catch-ul de mai jos înghițea eroarea, lăsând
        // tabela orfană pinned_items_new în orice instalare nouă. Reprodus pe
        // o bază curată înainte de fix.
        const hasUserId = cols.some((c) => c.name === "user_id");
        if (cols.length > 0 && !hasUserId) {
          const admin = database
            .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1")
            .get() as { id: number } | undefined;

          database.exec(`
            CREATE TABLE pinned_items_new (
              user_id INTEGER NOT NULL,
              id INTEGER NOT NULL,
              media_type TEXT NOT NULL,
              title TEXT NOT NULL,
              original_title TEXT NOT NULL,
              poster_url TEXT,
              sort_order INTEGER NOT NULL DEFAULT 0,
              added_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (user_id, id, media_type)
            );
          `);
          if (admin) {
            database
              .prepare(
                `INSERT INTO pinned_items_new (user_id, id, media_type, title, original_title, poster_url, sort_order, added_at)
                 SELECT ?, id, media_type, title, original_title, poster_url, sort_order, added_at FROM pinned_items`,
              )
              .run(admin.id);
          }
          database.exec("DROP TABLE pinned_items");
          database.exec("ALTER TABLE pinned_items_new RENAME TO pinned_items");
          console.log(
            `[db] Migrare v9: pinned_items devine per-utilizator (fixările existente → admin id=${admin?.id ?? "necunoscut"})`,
          );
        }
      } catch (e) {
        console.warn("[db] Migrare v9 eșuată:", e);
      }
      database.exec("PRAGMA user_version = 9");
    }

    if (version < 10) {
      // v10: istoric de autentificări per cont (pentru pagina de detalii
      // din Utilizatori) — last_login_at pe users + tabelă user_logins cu
      // fiecare login (IP, user-agent).
      try {
        database.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT");
        console.log("[db] Migrare v10: adăugat users.last_login_at");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      // user_logins e creată deja de blocul de schemă de mai sus (rulează la
      // fiecare pornire, indiferent de versiune) — nimic de migrat aici.
      database.exec("PRAGMA user_version = 10");
    }

    if (version < 11) {
      // v11: atribuie descărcările contului care le-a inițiat (pentru
      // secțiunea de detalii din Utilizatori) — doar descărcările de acum
      // înainte; cele vechi rămân neatribuite (NULL), fiindcă nu exista
      // legătura de cont la momentul lor.
      try {
        database.exec("ALTER TABLE downloads ADD COLUMN requested_by_user_id INTEGER");
        console.log("[db] Migrare v11: adăugat downloads.requested_by_user_id");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      database.exec("PRAGMA user_version = 11");
    }

    if (version < 12) {
      // v12: media capătă plex_added_at — data reală la care Plex a indexat
      // fișierul (nu momentul la care a pornit descărcarea sau la care a
      // rulat backfill-ul), necesară ca lista din Bibliotecă (sortată
      // descrescător după ea) să reflecte ordinea reală de apariție, nu
      // ordinea în care a rulat ultimul backfill.
      try {
        database.exec("ALTER TABLE media ADD COLUMN plex_added_at INTEGER");
        console.log("[db] Migrare v12: adăugat media.plex_added_at");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      database.exec("PRAGMA user_version = 12");
    }

    if (version < 13) {
      // v13: torrent_hash nu mai e UNIQUE — un pachet de sezon e un singur
      // torrent cu mai multe episoade, deci mai multe rânduri `media` chiar
      // trebuie să partajeze același hash. Acțiunile (ștergere, corectare
      // subtitrare) rămân cheiate pe torrent_hash și se aplică acum la
      // nivelul întregului pachet, intenționat.
      try {
        database.exec("DROP INDEX IF EXISTS idx_media_torrent_hash");
        database.exec(
          "CREATE INDEX IF NOT EXISTS idx_media_torrent_hash ON media(torrent_hash) WHERE torrent_hash IS NOT NULL",
        );
        console.log("[db] Migrare v13: torrent_hash nu mai e UNIQUE în media");
      } catch {
        // deja migrat
      }
      database.exec("PRAGMA user_version = 13");
    }

    if (version < 14) {
      // v14: elimină complet funcția de fixare/urmărire ("carduri fixate",
      // Pinned Watcher, notificările lui) — tabelele nu mai sunt scrise sau
      // citite de niciun cod, doar clutter mort altfel.
      database.exec("DROP TABLE IF EXISTS pinned_items");
      database.exec("DROP TABLE IF EXISTS pinned_watch_settings");
      database.exec("DROP TABLE IF EXISTS pinned_watch_state");
      console.log(
        "[db] Migrare v14: eliminate tabelele pinned_items/pinned_watch_settings/pinned_watch_state",
      );
      database.exec("PRAGMA user_version = 14");
    }

    if (version < 15) {
      try {
        database.exec("ALTER TABLE media ADD COLUMN has_romanian_audio INTEGER NOT NULL DEFAULT 0");
        console.log("[db] Migrare v15: adăugat media.has_romanian_audio");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      database.exec("PRAGMA user_version = 15");
    }

    if (version < 16) {
      // v16: recent_watch_cache capătă progres (view_offset_ms/duration_ms +
      // completed), ca vizionările neterminate să apară în "Vizionări
      // recente" cu minute vizionate, nu doar cele confirmate de istoricul
      // Plex (care nu înregistrează sub pragul lui de completare).
      try {
        database.exec("ALTER TABLE recent_watch_cache ADD COLUMN view_offset_ms INTEGER");
        database.exec("ALTER TABLE recent_watch_cache ADD COLUMN duration_ms INTEGER");
        database.exec(
          "ALTER TABLE recent_watch_cache ADD COLUMN completed INTEGER NOT NULL DEFAULT 1",
        );
        database.exec("ALTER TABLE plex_active_sessions ADD COLUMN rating_key TEXT");
        console.log("[db] Migrare v16: adăugat progres pe recent_watch_cache");
      } catch {
        // coloanele există deja dintr-o rulare anterioară
      }
      database.exec("PRAGMA user_version = 16");
    }

    if (version < 17) {
      // v17: curăță pinned_items_new, tabela orfană lăsată în urmă de v9 pe
      // bazele create înainte de fixul de mai sus (v9 crea tabela, apoi pica
      // la copiere fiindcă pinned_items nu exista, iar eroarea era înghițită).
      database.exec("DROP TABLE IF EXISTS pinned_items_new");
      database.exec("PRAGMA user_version = 17");
    }

    if (version < 18) {
      // v18: push_subscriptions capătă identitate. Până acum reținea doar
      // endpoint + chei, deci un abonament mort nu putea fi deosebit de unul
      // viu decât trimițând notificări de test și întrebând utilizatorul unde
      // au apărut. `display_mode` e singurul semnal care separă PWA-ul instalat
      // de browser — pe Android WebAPK-ul trimite exact același user-agent ca
      // Chrome, deci UA-ul singur nu ajunge.
      try {
        database.exec("ALTER TABLE push_subscriptions ADD COLUMN user_agent TEXT");
        database.exec("ALTER TABLE push_subscriptions ADD COLUMN display_mode TEXT");
        database.exec("ALTER TABLE push_subscriptions ADD COLUMN last_seen_at TEXT");
        console.log("[db] Migrare v18: push_subscriptions capătă user_agent/display_mode");
      } catch {
        // coloanele există deja dintr-o rulare anterioară
      }
      database.exec("PRAGMA user_version = 18");
    }

    if (version < 19) {
      // v19: urmărirea episoadelor noi revine, dar de data asta ca patru
      // coloane pe rândul-părinte 'tv_show' din `media`, nu ca tabelă
      // paralelă (vezi comentariul de la definiția tabelei).
      for (const sql of [
        "ALTER TABLE media ADD COLUMN auto_download INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE media ADD COLUMN auto_download_quality TEXT",
        "ALTER TABLE media ADD COLUMN auto_download_from TEXT",
        "ALTER TABLE media ADD COLUMN watch_last_checked_at TEXT",
      ]) {
        try {
          database.exec(sql);
        } catch {
          // coloana există deja dintr-o rulare anterioară
        }
      }

      // Seriale rămase fără niciun episod: rânduri-părinte create de
      // backfill pentru titluri pe care Plex le lista, dar cărora nu li s-a
      // legat niciodată conținut real. Curățarea existentă din log.ts le
      // prinde doar la ștergerea unui episod al lor — astea n-au avut
      // niciodată vreunul, deci rămâneau la nesfârșit (găsite 2 pe
      // 2026-09-06: "Temptation Island - Reunion", "Plaha").
      const orphans = database
        .prepare(
          `DELETE FROM media
             WHERE media_type = 'tv_show'
               AND torrent_hash IS NULL
               AND id NOT IN (SELECT parent_id FROM media WHERE parent_id IS NOT NULL)`,
        )
        .run();
      if (orphans.changes > 0) {
        console.log(`[db] Migrare v19: eliminate ${orphans.changes} seriale fără episoade`);
      }
      database.exec("PRAGMA user_version = 19");
    }

    if (version < 20) {
      // v20: numele episoadelor. Rândurile de tip 'episode' țineau în `title`
      // titlul serialului, deci numele episodului nu exista nicăieri în
      // aplicație — era rezolvat din TMDB doar ca să intre în textul unei
      // notificări (buildTorrentDisplayName) și aruncat imediat după.
      // Completarea efectivă e treaba lui fillMissingEpisodeTitles.
      try {
        database.exec("ALTER TABLE media ADD COLUMN episode_title TEXT");
        console.log("[db] Migrare v20: adăugat media.episode_title");
      } catch {
        // coloana există deja dintr-o rulare anterioară
      }
      database.exec("PRAGMA user_version = 20");
    }

    if (version < 21) {
      // v21: watch_last_checked_at era scris cu new Date().toISOString(), în
      // timp ce toate celelalte coloane de timp din `media` folosesc formatul
      // SQLite. Valorile deja scrise trebuie aduse la același format, altfel
      // rămân invizibile în UI (dată invalidă) și, mai grav, ies din
      // comparația de scadență din checkDueShows, care e lexicografică.
      const fixed = database
        .prepare(
          `UPDATE media
              SET watch_last_checked_at =
                    replace(substr(watch_last_checked_at, 1, 19), 'T', ' ')
            WHERE watch_last_checked_at LIKE '%T%'`,
        )
        .run();
      if (fixed.changes > 0) {
        console.log(`[db] Migrare v21: normalizate ${fixed.changes} watch_last_checked_at`);
      }
      database.exec("PRAGMA user_version = 21");
    }

    if (version < 22) {
      // v22: următorul episod anunțat + reîmprospătarea periodică a
      // metadatelor de serial. TMDB întoarce next_episode_to_air în același
      // răspuns pe care îl cerem oricum, deci informația exista deja și era
      // aruncată.
      for (const sql of [
        "ALTER TABLE media ADD COLUMN next_episode TEXT",
        "ALTER TABLE media ADD COLUMN next_episode_air_date TEXT",
        "ALTER TABLE media ADD COLUMN next_episode_airstamp TEXT",
        "ALTER TABLE media ADD COLUMN meta_refreshed_at TEXT",
      ]) {
        try {
          database.exec(sql);
        } catch {
          // coloana există deja dintr-o rulare anterioară
        }
      }
      database.exec("PRAGMA user_version = 22");
    }
  }
}
