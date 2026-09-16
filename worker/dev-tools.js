import { z } from "zod";

const WRITE = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: false,
};

const READ_ONLY = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
};

const BASE = "https://api.github.com";

function safePath(value) {
  const p = String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "");

  if (
    !p ||
    p.startsWith("/") ||
    p.split("/").includes("..") ||
    /(^|\/)(\.git|\.env|node_modules|credentials?|secrets?|private[-_.]?keys?|tokens?)(\/|$)/i.test(p)
  ) {
    return null;
  }

  return p;
}

function config(env) {
  if (
    !env.GITHUB_TOKEN ||
    !env.GITHUB_OWNER ||
    !env.GITHUB_REPO ||
    !env.GITHUB_BRANCH
  ) {
    throw new Error("GitHub MCP configuration is incomplete");
  }

  return {
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    baseBranch: env.GITHUB_BRANCH,
  };
}

async function gh(env, path, options = {}) {
  const c = config(env);

  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${c.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 1000)}`);
  }

  if (response.status === 204) return null;

  return response.json();
}

async function getBranchSha(env, branch) {
  const c = config(env);

  const ref = await gh(
    env,
    `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/git/ref/heads/${encodeURIComponent(branch)}`
  );

  return ref.object.sha;
}

function changeBranch(id) {
  return `mcp-change/${id}`;
}

export function registerDevelopmentTools(server, env, mcpResult) {
  server.registerTool(
    "begin_change_set",
    {
      title: "Source変更セットを開始",
      description:
        "現在mainのcommitを確認し、隔離されたMCP変更branchを作成する。",
      inputSchema: {
        expectedBaseCommit: z.string().min(7).max(64),
        description: z.string().min(1).max(500),
      },
      annotations: WRITE,
    },
    async ({ expectedBaseCommit, description }) => {
      try {
        const c = config(env);
        const current = await getBranchSha(env, c.baseBranch);

        if (current !== expectedBaseCommit) {
          return {
            isError: true,
            structuredContent: {
              error: "base commitが更新されている",
              expectedBaseCommit,
              currentCommit: current,
            },
            content: [{ type: "text", text: "base commitが更新されている" }],
          };
        }

        const changeSetId = crypto.randomUUID();
        const branch = changeBranch(changeSetId);

        await gh(
          env,
          `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/git/refs`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ref: `refs/heads/${branch}`,
              sha: current,
            }),
          }
        );

        return mcpResult({
          changeSetId,
          branch,
          baseCommit: current,
          description,
        });
      } catch (error) {
        return {
          isError: true,
          structuredContent: { error: error.message },
          content: [{ type: "text", text: error.message }],
        };
      }
    }
  );

  server.registerTool(
    "get_working_diff",
    {
      title: "変更差分を取得",
      description:
        "Change Set branchとmainを比較して変更ファイルとdiffを取得する。",
      inputSchema: {
        changeSetId: z.string().uuid(),
      },
      annotations: READ_ONLY,
    },
    async ({ changeSetId }) => {
      try {
        const c = config(env);
        const head = changeBranch(changeSetId);

        const data = await gh(
          env,
          `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/compare/${encodeURIComponent(c.baseBranch)}...${encodeURIComponent(head)}`
        );

        return mcpResult({
          aheadBy: data.ahead_by,
          behindBy: data.behind_by,
          totalCommits: data.total_commits,
          files: (data.files || []).map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            patch: f.patch,
          })),
        });
      } catch (error) {
        return {
          isError: true,
          structuredContent: { error: error.message },
          content: [{ type: "text", text: error.message }],
        };
      }
    }
  );

  server.registerTool(
    "patch_source_file",
    {
      title: "Source fileを部分更新",
      description:
        "Change Set上の安全なrepository fileについて、一意一致する文字列だけを置換する。",
      inputSchema: {
        changeSetId: z.string().uuid(),
        path: z.string().min(1).max(300),
        oldText: z.string().min(1).max(50000),
        newText: z.string().max(50000),
        expectedFileSha: z.string().min(1).max(100),
        message: z.string().min(1).max(200).default("MCP source patch"),
      },
      annotations: WRITE,
    },
    async ({
      changeSetId,
      path,
      oldText,
      newText,
      expectedFileSha,
      message,
    }) => {
      try {
        const c = config(env);
        const safe = safePath(path);
        if (!safe) throw new Error("許可されていないpath");

        const branch = changeBranch(changeSetId);

        const file = await gh(
          env,
          `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${safe}?ref=${encodeURIComponent(branch)}`
        );

        if (file.type !== "file") throw new Error("通常fileではない");
        if (file.sha !== expectedFileSha)
          throw new Error("file SHAが取得時点から変更されている");

        const current = Uint8Array.from(
          atob(String(file.content || "").replace(/\n/g, "")),
          (x) => x.charCodeAt(0)
        );

        const text = new TextDecoder().decode(current);

        const first = text.indexOf(oldText);
        if (first < 0) throw new Error("oldTextが見つからない");

        if (text.indexOf(oldText, first + oldText.length) >= 0)
          throw new Error("oldTextが複数箇所に一致する");

        const updated =
          text.slice(0, first) +
          newText +
          text.slice(first + oldText.length);

        const bytes = new TextEncoder().encode(updated);

        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const content = btoa(binary);

        const saved = await gh(
          env,
          `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${safe}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message,
              content,
              sha: file.sha,
              branch,
            }),
          }
        );

        return mcpResult({
          updated: true,
          path: safe,
          branch,
          commit: saved.commit?.sha,
          fileSha: saved.content?.sha,
        });
      } catch (error) {
        return {
          isError: true,
          structuredContent: { error: error.message },
          content: [{ type: "text", text: error.message }],
        };
      }
    }
  );
}
