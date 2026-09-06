import { createServerFn } from "@tanstack/react-start";
import { execSync, execFileSync } from "child_process";

export interface GitHubCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface GitHubCommitsResult {
  status: "ok" | "error";
  error?: string;
  commits: GitHubCommit[];
}

export interface GitHubCommitFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | string;
  additions: number;
  deletions: number;
}

export interface GitHubCommitDetail {
  status: "ok" | "error";
  error?: string;
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  url: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  files: GitHubCommitFile[];
}

interface GitHubApiCommit {
  sha?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
  author?: { login?: string };
  html_url?: string;
  stats?: { additions?: number; deletions?: number };
  files?: Array<{ filename?: string; status?: string; additions?: number; deletions?: number }>;
}

const GITHUB_REPO = process.env.GITHUB_REPO ?? "Faicu/FaikkitBox";

// Un SHA de git e hex, atât. Validarea NU e cosmetică: `data.sha` ajunge
// argument pentru `git show`, iar execFileSync nu folosește shell, deci nu
// există injecție de shell — dar există injecție de ARGUMENT. `git show`
// acceptă opțiunile de diff, printre care `--output=<fișier>`: un sha de
// forma "--output=/root/.ssh/authorized_keys" scrie liniștit în calea aia.
// Serviciul rulează ca root, deci era o scriere arbitrară de fișier ca root,
// pornind de la o sesiune de admin — exact genul de acces pe care restul
// aplicației îl evită cu grijă (vezi lista albă din runAgentCommand, unde
// argumentele nu vin niciodată de la client).
//
// Verificat pe repo-ul ăsta: `git show --numstat --format= --output=/tmp/x`
// chiar creează /tmp/x.
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function assertValidSha(sha: string): string {
  if (!SHA_RE.test(sha)) throw new Error("SHA invalid");
  return sha;
}

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "faikkitbox-dashboard",
  };
  if (process.env.GITHUB_TOKEN) h["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function upsertCommits(commits: GitHubCommit[]): Promise<void> {
  try {
    const { getDb } = await import("./db");
    const { notifyGithubCommits } = await import("./notifications/notifications");
    const db = getDb();
    const now = new Date().toISOString();
    const fresh: Array<{ author: string; message: string }> = [];

    // INSERT OR IGNORE (nu REPLACE) — ca să putem detecta commit-urile chiar noi
    // și să trimitem notificare push, indiferent care sursă (webhook, sync la
    // pornire sau acest polling periodic) le descoperă prima.
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO commits (sha, short_sha, message, author, date, url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of commits) {
      const result = stmt.run(c.sha, c.shortSha, c.message, c.author, c.date, c.url, now);
      if (result.changes > 0) fresh.push({ author: c.author, message: c.message });
    }
    // O singură notificare pentru tot lotul, nu una per commit.
    await notifyGithubCommits(fresh).catch((err) => {
      console.warn("[github] Trimitere push eșuată:", err);
    });
  } catch (e) {
    console.warn("[github] Upsert commits eșuat:", e);
  }
}

// Fetch GitHub + upsert în DB (rulat periodic din React Query)
export const getRecentCommits = createServerFn({ method: "GET" }).handler(
  async (): Promise<GitHubCommitsResult> => {
    const { requireAdmin } = await import("./auth/admin.server");
    await requireAdmin();
    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=20`, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`GitHub API a răspuns ${res.status}`);
      const raw: GitHubApiCommit[] = await res.json();
      if (!Array.isArray(raw)) throw new Error("Răspuns neașteptat de la GitHub API");

      const commits: GitHubCommit[] = raw.map((c) => ({
        sha: String(c.sha ?? ""),
        shortSha: String(c.sha ?? "").slice(0, 7),
        message: String(c.commit?.message ?? "").split("\n")[0],
        author: c.commit?.author?.name ?? c.author?.login ?? "necunoscut",
        date: c.commit?.author?.date ?? c.commit?.committer?.date ?? "",
        url: c.html_url ?? `https://github.com/${GITHUB_REPO}/commit/${c.sha}`,
      }));

      // Salvează în DB — acumulează istoric nelimitat
      await upsertCommits(commits);

      return { status: "ok", commits };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e), commits: [] };
    }
  },
);

// Citește commits din DB — sursa principală pentru timeline
export const getCommitsFromDb = createServerFn({ method: "GET" }).handler(
  async (): Promise<GitHubCommitsResult> => {
    const { requireAdmin } = await import("./auth/admin.server");
    await requireAdmin();
    try {
      const { getDb } = await import("./db");
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT sha, short_sha, message, author, date, url
         FROM commits ORDER BY date DESC LIMIT 500`,
        )
        .all() as Array<{
        sha: string;
        short_sha: string;
        message: string;
        author: string;
        date: string;
        url: string;
      }>;

      const commits: GitHubCommit[] = rows.map((r) => ({
        sha: r.sha,
        shortSha: r.short_sha,
        message: r.message,
        author: r.author,
        date: r.date,
        url: r.url,
      }));

      return { status: "ok", commits };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e), commits: [] };
    }
  },
);

// Detalii complete pentru un commit — live de pe GitHub, la cerere
export const getCommitDetail = createServerFn({ method: "GET" })
  .validator((data: { sha: string }) => {
    assertValidSha(data.sha);
    return data;
  })
  .handler(async ({ data }): Promise<GitHubCommitDetail> => {
    const { requireAdmin } = await import("./auth/admin.server");
    await requireAdmin();
    try {
      // encodeURIComponent în plus față de validare: sha e interpolat într-o
      // cale de URL, iar validarea singură e ușor de slăbit din greșeală mai
      // târziu.
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/commits/${encodeURIComponent(data.sha)}`,
        {
          headers: githubHeaders(),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!res.ok) throw new Error(`GitHub API a răspuns ${res.status}`);
      const c: GitHubApiCommit = await res.json();

      return {
        status: "ok",
        sha: String(c.sha ?? ""),
        shortSha: String(c.sha ?? "").slice(0, 7),
        message: String(c.commit?.message ?? ""),
        author: c.commit?.author?.name ?? c.author?.login ?? "necunoscut",
        date: c.commit?.author?.date ?? c.commit?.committer?.date ?? "",
        url: c.html_url ?? "",
        filesChanged: c.files?.length ?? 0,
        additions: c.stats?.additions ?? 0,
        deletions: c.stats?.deletions ?? 0,
        files: (c.files ?? []).map((f) => ({
          filename: String(f.filename ?? ""),
          status: String(f.status ?? "modified"),
          additions: Number(f.additions ?? 0),
          deletions: Number(f.deletions ?? 0),
        })),
      };
    } catch (e) {
      return {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        sha: data.sha,
        shortSha: data.sha.slice(0, 7),
        message: "",
        author: "",
        date: "",
        url: "",
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        files: [],
      };
    }
  });

export interface GitHubSyncStatus {
  deployedSha: string;
  deployedShortSha: string;
  latestSha: string;
  latestShortSha: string;
  isSynced: boolean;
  commitsBehind: number;
}

export const getGitHubSyncStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<
    { status: "ok"; data: GitHubSyncStatus } | { status: "error"; error: string }
  > => {
    const { requireAdmin } = await import("./auth/admin.server");
    await requireAdmin();
    try {
      const deployedSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=30`, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const commits: GitHubApiCommit[] = await res.json();

      const latestSha = String(commits[0]?.sha ?? "");
      const idx = commits.findIndex((c) => c.sha === deployedSha);
      const commitsBehind = idx === -1 ? (latestSha !== deployedSha ? 1 : 0) : idx;

      return {
        status: "ok",
        data: {
          deployedSha,
          deployedShortSha: deployedSha.slice(0, 7),
          latestSha,
          latestShortSha: latestSha.slice(0, 7),
          isSynced: deployedSha === latestSha,
          commitsBehind,
        },
      };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }
  },
);

export interface GitPushStatus {
  ahead: number;
  behind: number;
  branch: string;
}

// Numărul de commit-uri locale nepublicate — sursa pentru butonul de push din
// pagina Tehnic. `git fetch` e best-effort (doar actualizează referința locală
// origin/main, nu schimbă nimic din working tree); dacă eșuează (fără rețea),
// raportăm ahead/behind față de ultima referință cunoscută.
export const getGitPushStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ status: "ok"; data: GitPushStatus } | { status: "error"; error: string }> => {
    const { requireAdmin } = await import("./auth/admin.server");
    await requireAdmin();
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
      try {
        execFileSync("git", ["fetch", "--quiet", "origin", branch], { timeout: 8000 });
      } catch {
        // fără rețea sau fără acces — continuăm cu ce știm local
      }
      const ahead = Number(
        execSync(`git rev-list origin/${branch}..HEAD --count`, { encoding: "utf8" }).trim(),
      );
      const behind = Number(
        execSync(`git rev-list HEAD..origin/${branch} --count`, { encoding: "utf8" }).trim(),
      );
      return { status: "ok", data: { ahead, behind, branch } };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }
  },
);

export interface UnpushedCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
}

// Detalii despre commit-urile locale nepublicate — afișate deasupra butonului
// de push din pagina Tehnic, ca userul să vadă ce urmează să trimită.
export const getUnpushedCommits = createServerFn({ method: "GET" }).handler(
  async (): Promise<
    { status: "ok"; commits: UnpushedCommit[] } | { status: "error"; error: string }
  > => {
    const { requireAdmin } = await import("./auth/admin.server");
    await requireAdmin();
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
      const sep = "\x1f";
      const log = execSync(
        `git log origin/${branch}..HEAD --pretty=format:%H${sep}%h${sep}%s${sep}%an${sep}%aI`,
        { encoding: "utf8" },
      ).trim();
      const commits: UnpushedCommit[] = log
        ? log.split("\n").map((line) => {
            const [sha, shortSha, message, author, date] = line.split(sep);
            return { sha, shortSha, message, author, date };
          })
        : [];
      return { status: "ok", commits };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }
  },
);

// Detalii complete pentru un commit local (nepublicat încă pe GitHub) — citite
// direct din git, fiindcă GitHub API nu are cum să știe de el.
export const getLocalCommitDetail = createServerFn({ method: "GET" })
  .validator((data: { sha: string }) => {
    assertValidSha(data.sha);
    return data;
  })
  .handler(async ({ data }): Promise<GitHubCommitDetail> => {
    const { requireAdmin } = await import("./auth/admin.server");
    await requireAdmin();
    try {
      const sep = "\x1f";
      // `--end-of-options` peste validarea din validator: de aici încolo git
      // tratează orice urmează ca revizie, nu ca opțiune, chiar dacă cineva
      // slăbește cândva regexul. Două straturi, fiindcă greșeala aici scrie
      // fișiere ca root (vezi SHA_RE).
      const header = execFileSync(
        "git",
        [
          "show",
          "-s",
          `--pretty=format:%H${sep}%h${sep}%B${sep}%an${sep}%aI`,
          "--end-of-options",
          data.sha,
        ],
        { encoding: "utf8" },
      );
      const [sha, shortSha, message, author, date] = header.split(sep);

      const numstat = execFileSync(
        "git",
        ["show", "--numstat", "--format=", "--end-of-options", data.sha],
        { encoding: "utf8" },
      ).trim();
      const nameStatus = execFileSync(
        "git",
        ["show", "--name-status", "--format=", "--end-of-options", data.sha],
        { encoding: "utf8" },
      ).trim();
      const statusByFile = new Map<string, string>();
      for (const line of nameStatus ? nameStatus.split("\n") : []) {
        const [code, filename] = line.split("\t");
        if (!filename) continue;
        const status =
          code?.[0] === "A"
            ? "added"
            : code?.[0] === "D"
              ? "removed"
              : code?.[0] === "R"
                ? "renamed"
                : "modified";
        statusByFile.set(filename, status);
      }

      const files: GitHubCommitFile[] = (numstat ? numstat.split("\n") : []).map((line) => {
        const [add, del, filename] = line.split("\t");
        return {
          filename,
          status: statusByFile.get(filename) ?? "modified",
          additions: add === "-" ? 0 : Number(add),
          deletions: del === "-" ? 0 : Number(del),
        };
      });

      return {
        status: "ok",
        sha,
        shortSha,
        message: message.trim(),
        author,
        date,
        url: "",
        filesChanged: files.length,
        additions: files.reduce((s, f) => s + f.additions, 0),
        deletions: files.reduce((s, f) => s + f.deletions, 0),
        files,
      };
    } catch (e) {
      return {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        sha: data.sha,
        shortSha: data.sha.slice(0, 7),
        message: "",
        author: "",
        date: "",
        url: "",
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        files: [],
      };
    }
  });

export interface GitPushResult {
  status: "ok" | "error";
  error?: string;
  pushedCommits: number;
}

// Trimite commit-urile locale pe GitHub — apăsat manual din pagina Tehnic.
// Nu rulează build/restart: acelea s-au întâmplat deja când commit-urile au
// fost create local, push-ul doar le publică.
export const pushToGitHub = createServerFn({ method: "POST" }).handler(
  async (): Promise<GitPushResult> => {
    const { requireAdmin } = await import("./auth/admin.server");
    await requireAdmin();
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
      const ahead = Number(
        execSync(`git rev-list origin/${branch}..HEAD --count`, { encoding: "utf8" }).trim(),
      );
      if (ahead === 0) {
        return { status: "ok", pushedCommits: 0 };
      }
      execFileSync("git", ["push", "origin", branch], { timeout: 30_000 });
      return { status: "ok", pushedCommits: ahead };
    } catch (e) {
      return {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        pushedCommits: 0,
      };
    }
  },
);
