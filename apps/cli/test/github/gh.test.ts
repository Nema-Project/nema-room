import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GithubGh, githubApiRequest } from "../../src/github/gh.js";
import { spawnOwned } from "../../src/ownedProcess.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function fakeGh(source: string): string {
  dir ??= mkdtempSync(join(tmpdir(), "nema-gh-profile-"));
  const file = join(dir, "gh.mjs");
  writeFileSync(file, `#!${process.execPath}\n${source}`);
  chmodSync(file, 0o755);
  return file;
}

test("maps the six read tools to fixed endpoints and preserves all pagination inputs", () => {
  expect(githubApiRequest("pull_request_read", { owner: "Acme", repo: "web", pullNumber: 3, method: "get_files", page: 2, perPage: 50 })).toMatchObject({kind:"rest",endpoint:"repos/Acme/web/pulls/3/files",fields:{page:"2",per_page:"50"}});
  expect(githubApiRequest("pull_request_read", { owner:"a",repo:"b",pullNumber:3,method:"get_review_comments",after:"CURSOR",perPage:20 })).toMatchObject({kind:"graphql",variables:{owner:"a",name:"b",number:3,after:"CURSOR",first:20}});
  expect(githubApiRequest("list_pull_requests", {owner:"a",repo:"b",state:"open",page:2,perPage:20})).toMatchObject({kind:"rest",endpoint:"repos/a/b/pulls",fields:{state:"open",page:"2",per_page:"20"}});
  expect(githubApiRequest("search_pull_requests", {query:"repo:a/b is:open",page:1,perPage:5})).toMatchObject({kind:"rest",endpoint:"search/issues",fields:{q:"is:pr repo:a/b is:open",page:"1",per_page:"5"}});
  expect(githubApiRequest("issue_read", {owner:"a",repo:"b",issue_number:4,method:"get_parent"})).toMatchObject({kind:"graphql",variables:{owner:"a",name:"b",number:4}});
  expect(githubApiRequest("pull_request_read", {owner:"a",repo:"b",pullNumber:3,method:"get"})).toMatchObject({kind:"rest",endpoint:"repos/a/b/pulls/3"});
  expect(githubApiRequest("pull_request_read", {owner:"a",repo:"b",pullNumber:3,method:"get_diff"})).toMatchObject({kind:"rest",accept:"application/vnd.github.v3.diff"});
  expect(githubApiRequest("pull_request_read", {owner:"a",repo:"b",pullNumber:3,method:"get_status"})).toMatchObject({kind:"pr_status",owner:"a",repo:"b",number:3});
  expect(githubApiRequest("pull_request_read", {owner:"a",repo:"b",pullNumber:3,method:"get_commits",page:2,perPage:5})).toMatchObject({kind:"rest",endpoint:"repos/a/b/pulls/3/commits",fields:{page:"2",per_page:"5"}});
  expect(githubApiRequest("list_issues", {owner:"a",repo:"b",after:"CURSOR",perPage:20,state:"open",labels:["bug"]})).toMatchObject({kind:"graphql",variables:{owner:"a",name:"b",after:"CURSOR",first:20,states:["OPEN"],labels:["bug"]}});
  expect(githubApiRequest("pull_request_read", {owner:"a",repo:"b",pullNumber:3,method:"get_check_runs",page:2,perPage:5})).toMatchObject({kind:"check_runs",fields:{page:"2",per_page:"5"}});
  expect(githubApiRequest("pull_request_read", {owner:"a",repo:"b",pullNumber:3,method:"get_reviews",page:2,perPage:5})).toMatchObject({kind:"rest",endpoint:"repos/a/b/pulls/3/reviews",fields:{page:"2",per_page:"5"}});
  expect(githubApiRequest("pull_request_read", {owner:"a",repo:"b",pullNumber:3,method:"get_comments",page:2,perPage:5})).toMatchObject({kind:"rest",endpoint:"repos/a/b/issues/3/comments",fields:{page:"2",per_page:"5"}});
  expect(githubApiRequest("search_issues", {query:"repo:a/b is:issue",page:2,perPage:10})).toMatchObject({kind:"rest",endpoint:"search/issues",fields:{q:"repo:a/b is:issue",page:"2",per_page:"10"}});
  expect(githubApiRequest("issue_read", {owner:"a",repo:"b",issue_number:4,method:"get"})).toMatchObject({kind:"rest",endpoint:"repos/a/b/issues/4"});
  expect(githubApiRequest("issue_read", {owner:"a",repo:"b",issue_number:4,method:"get_comments",page:2})).toMatchObject({kind:"rest",endpoint:"repos/a/b/issues/4/comments",fields:{page:"2"}});
  expect(githubApiRequest("issue_read", {owner:"a",repo:"b",issue_number:4,method:"get_sub_issues",perPage:8})).toMatchObject({kind:"rest",endpoint:"repos/a/b/issues/4/sub_issues",fields:{per_page:"8"}});
  expect(githubApiRequest("issue_read", {owner:"a",repo:"b",issue_number:4,method:"get_labels",page:2})).toMatchObject({kind:"rest",endpoint:"repos/a/b/issues/4/labels",fields:{page:"2"}});
  expect(() => githubApiRequest("issue_read", {owner:"a",repo:"b",issue_number:4,method:"delete"})).toThrow(/unsupported/i);
  expect(() => githubApiRequest("list_pull_requests", {owner:"a",repo:"b",page:0})).toThrow(/page/i);
  expect(() => githubApiRequest("list_issues", {owner:"a",repo:"b",page:2})).toThrow(/page/i);
  expect(() => githubApiRequest("pull_request_read", {owner:"a",repo:"b",pullNumber:3,method:"get",after:"ignored"})).toThrow(/after/i);
});

test("check-run requests derive and validate the head SHA before forming their second fixed GET", async () => {
  dir=mkdtempSync(join(tmpdir(),"nema-gh-profile-"));
  const record=join(dir,"calls.jsonl");
  const bin=fakeGh(`import { appendFileSync } from "node:fs"; const a=process.argv.slice(2); appendFileSync(${JSON.stringify(record)},JSON.stringify({a,input:process.stdin.readableLength})+"\\n"); if(a.some((x)=>x.endsWith("/pulls/7"))) process.stdout.write(JSON.stringify({head:{sha:"0123456789abcdef0123456789abcdef01234567"}})); else process.stdout.write(JSON.stringify({check_runs:[]}));`);
  const gh=new GithubGh({bin});
  try {
    const result=await gh.call("pull_request_read",{owner:"a",repo:"b",pullNumber:7,method:"get_check_runs",page:3,perPage:17});
    expect(result).toContain("check_runs");
    const calls=readFileSync(record,"utf8").trim().split("\n").map((x)=>JSON.parse(x) as {a:string[]});
    expect(calls).toHaveLength(2);
    expect(calls[0]!.a).toEqual(["api","--hostname","github.com","--method","GET","repos/a/b/pulls/7"]);
    expect(calls[1]!.a).toContain("repos/a/b/commits/0123456789abcdef0123456789abcdef01234567/check-runs");
    expect(calls[1]!.a).toContain("page=3"); expect(calls[1]!.a).toContain("per_page=17");
  } finally { await gh.close(); }
});

test("uses explicit gh login environment, forces GET for REST, and returns CLI data", async () => {
  const record = join((dir = mkdtempSync(join(tmpdir(), "nema-gh-profile-"))), "args.json");
  const bin = fakeGh(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),env:Object.keys(process.env).sort()})); process.stdout.write('[{"ok":true}]');`);
  const gh = new GithubGh({bin,env:{...process.env,GH_TOKEN:"fake-secret",NEMA_TEST_SECRET:"must-not-pass"}});
  try {
    await expect(gh.call("list_pull_requests", {owner:"o",repo:"r",page:2})).resolves.toContain('"ok"');
    const seen=JSON.parse(readFileSync(record,"utf8")) as {args:string[];env:string[]};
    expect(seen.args).toContain("GET"); expect(seen.args).toContain("page=2"); expect(seen.env).toContain("GH_TOKEN"); expect(seen.env).not.toContain("NEMA_TEST_SECRET");
  } finally { await gh.close(); }
});

test("status parses active account JSON even when gh exits zero and does not expose stderr", async () => {
  const bin=fakeGh(`const a=process.argv.slice(2); if(a[0]==="--version") process.stdout.write("gh version 2.60.0"); else {process.stderr.write("token ghp_secret_marker"); process.stdout.write(JSON.stringify({hosts:{"github.com":[{active:false,state:"failed"}]}}));}`);
  const gh=new GithubGh({bin});
  try { expect(await gh.status()).toEqual({installed:true,loggedIn:false,detail:"GitHub CLI installed; no active github.com login"}); }
  finally { await gh.close(); }
});

test("uses the managed owned-helper scope for fake gh calls", async () => {
  dir??=mkdtempSync(join(tmpdir(),"nema-gh-profile-"));
  const guardian=join(dir,"owned-helper.exe");
  if(process.platform==="win32") execFileSync(process.execPath,[join(process.cwd(),"scripts/desktop/build-owned-helper.mjs"),"--output",guardian],{stdio:"inherit"});
  const bin=fakeGh(`process.stdout.write("managed-result")`);
  const spawned:string[]=[];
  const scope:OwnedHelperScope={
    async spawn(command,args,options){
      spawned.push(command);
      if(process.platform==="win32") return spawnOwned(guardian,command,args,options);
      // POSIX has no native guardian yet: a plain child with the same lifecycle shape is enough to prove the scope is used.
      const child=spawn(command,args,{cwd:options?.cwd,env:options?.env,stdio:options?.stdio});
      const exit=(event:"exit"|"close")=>new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve)=>child.once(event,(code,signal)=>resolve({code,signal})));
      return {stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,kill:(signal)=>child.kill(signal),exited:exit("exit"),closed:exit("close")};
    },
    stopAccepting(){},
    async drain(){},
  };
  const gh=new GithubGh({bin,ownedHelpers:scope});
  try { await expect(gh.call("list_issues",{owner:"a",repo:"b"})).resolves.toBe("managed-result"); expect(spawned).toHaveLength(1); }
  finally { await gh.close(); }
});

test("gh_write runs the normalized argv against github.com and gh_read refuses a write command", async () => {
  dir=mkdtempSync(join(tmpdir(),"nema-gh-profile-"));
  const record=join(dir,"cmd.json");
  const bin=fakeGh(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(record)},JSON.stringify({a:process.argv.slice(2),host:process.env.GH_HOST,prompt:process.env.GH_PROMPT_DISABLED})); process.stdout.write("https://github.com/a/b/issues/9\\n");`);
  const gh=new GithubGh({bin});
  const bound=[{owner:"a",repo:"b"}];
  try {
    await expect(gh.call("gh_write",{args:["issue","create","-R","A/B","--title","t","--body","-b"],bound})).resolves.toBe("https://github.com/a/b/issues/9\n");
    const seen=JSON.parse(readFileSync(record,"utf8")) as {a:string[];host:string;prompt:string};
    expect(seen).toEqual({a:["issue","create","--repo=A/B","--title=t","--body=-b"],host:"github.com",prompt:"1"});
    await expect(gh.call("gh_read",{args:["issue","create","--repo","a/b","--title","t","--body","x"],bound})).rejects.toThrow(/does not match/);
    await expect(gh.call("gh_write",{args:["issue","create","--repo","a/other","--title","t","--body","x"],bound})).rejects.toThrow(/bound/);
    await expect(gh.call("gh_write",{args:["issue","create","--repo","a/b","--title","t","--body","x"]})).rejects.toThrow(/bound/);
  } finally { await gh.close(); }
});

test("a failing gh command reports its exit code and stderr with token-like strings redacted", async () => {
  const bin=fakeGh(`process.stderr.write("GraphQL: no such label (token ghp_abcdefghijklmnopqrstuvwxyz0123456789)"); process.exit(1);`);
  const gh=new GithubGh({bin});
  try {
    const error=await gh.call("gh_read",{args:["issue","list","--repo","a/b"],bound:[{owner:"a",repo:"b"}]}).catch((e:Error)=>e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("exit 1");
    expect((error as Error).message).toContain("no such label");
    expect((error as Error).message).not.toContain("ghp_abcdef");
  } finally { await gh.close(); }
});

test("status tells a missing gh apart from a check that could not finish", async () => {
  const missing = new GithubGh({ bin: join(tmpdir(), "nema-no-such-gh", "gh") });
  try { expect(await missing.status()).toEqual({ installed: false, loggedIn: false, detail: "GitHub CLI unavailable" }); }
  finally { await missing.close(); }
  const brokenVersion = new GithubGh({ bin: fakeGh(`process.exit(3);`) });
  try { expect(await brokenVersion.status()).toMatchObject({ installed: false, loggedIn: false, inconclusive: true }); }
  finally { await brokenVersion.close(); }
  rmSync(dir!, { recursive: true, force: true }); dir = undefined;
  const garbled = new GithubGh({ bin: fakeGh(`const a=process.argv.slice(2); process.stdout.write(a[0]==="--version" ? "gh version 2.60.0" : "not json");`) });
  try { expect(await garbled.status()).toMatchObject({ installed: true, loggedIn: false, inconclusive: true }); }
  finally { await garbled.close(); }
  rmSync(dir!, { recursive: true, force: true }); dir = undefined;
  // gh exits 1 when nobody is signed in: that is an answer, not a failed check.
  const signedOut = new GithubGh({ bin: fakeGh(`const a=process.argv.slice(2); if(a[0]==="--version") process.stdout.write("gh version 2.60.0"); else process.exit(1);`) });
  try {
    const status = await signedOut.status();
    expect(status).toMatchObject({ installed: true, loggedIn: false });
    expect(status.inconclusive).toBeUndefined();
  }
  finally { await signedOut.close(); }
});

const HEAD40 = "0123456789abcdef0123456789abcdef01234567";

test("reads one page of check runs and marks a short page truncated", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-gh-profile-"));
  const record = join(dir, "calls.jsonl");
  const bin = fakeGh(`import { appendFileSync } from "node:fs"; const a=process.argv.slice(2); appendFileSync(${JSON.stringify(record)},JSON.stringify(a)+"\\n"); if(a.some((x)=>x.endsWith("/pulls/7"))) process.stdout.write(JSON.stringify({head:{sha:"${HEAD40.toUpperCase()}"}})); else process.stdout.write(JSON.stringify({total_count:2,check_runs:[{name:"ci",status:"completed",conclusion:"failure",html_url:"https://github.com/a/b/runs/1"}]}));`);
  const gh = new GithubGh({ bin });
  try {
    const result = await gh.observePullRequest({ owner: "a", repo: "b", pr: 7, perPage: 100 });
    expect(result).toEqual({
      outcome: "read",
      observedHeadSha: HEAD40,
      checkRuns: [{ name: "ci", status: "completed", conclusion: "failure", url: "https://github.com/a/b/runs/1" }],
      truncated: true,
    });
    const calls = readFileSync(record, "utf8").trim().split("\n").map((x) => JSON.parse(x) as string[]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["api", "--hostname", "github.com", "--method", "GET", "repos/a/b/pulls/7"]);
    expect(calls[1]).toContain(`repos/a/b/commits/${HEAD40}/check-runs`);
    expect(calls[1]).toContain("per_page=100");
    expect(calls[1]!.some((x) => x.startsWith("page="))).toBe(false);
  } finally { await gh.close(); }
});

test("a full page is not truncated and a check run without a url keeps null", async () => {
  const bin = fakeGh(`const a=process.argv.slice(2); if(a.some((x)=>x.endsWith("/pulls/7"))) process.stdout.write(JSON.stringify({head:{sha:"${HEAD40}"}})); else process.stdout.write(JSON.stringify({total_count:1,check_runs:[{name:"ci",status:"in_progress",conclusion:null}]}));`);
  const gh = new GithubGh({ bin });
  try {
    expect(await gh.observePullRequest({ owner: "a", repo: "b", pr: 7, perPage: 100 })).toEqual({
      outcome: "read", observedHeadSha: HEAD40, checkRuns: [{ name: "ci", status: "in_progress", conclusion: null, url: null }], truncated: false,
    });
  } finally { await gh.close(); }
});

test("a check-runs body without total_count is marked truncated", async () => {
  const bin = fakeGh(`const a=process.argv.slice(2); if(a.some((x)=>x.endsWith("/pulls/7"))) process.stdout.write(JSON.stringify({head:{sha:"${HEAD40}"}})); else process.stdout.write(JSON.stringify({check_runs:[]}));`);
  const gh = new GithubGh({ bin });
  try {
    expect(await gh.observePullRequest({ owner: "a", repo: "b", pr: 7, perPage: 100 })).toMatchObject({ outcome: "read", checkRuns: [], truncated: true });
  } finally { await gh.close(); }
});

test("returns out of scope on a 404 for that repo", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-gh-profile-"));
  const record = join(dir, "calls.jsonl");
  const bin = fakeGh(`import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2))+"\\n"); process.stdout.write(JSON.stringify({message:"Not Found"})); process.exit(1);`);
  const gh = new GithubGh({ bin });
  try {
    expect(await gh.observePullRequest({ owner: "a", repo: "b", pr: 7, perPage: 100 })).toEqual({ outcome: "out_of_scope" });
    expect(readFileSync(record, "utf8").trim().split("\n")).toHaveLength(1);
  } finally { await gh.close(); }
});

test("rejects a head that is not 40 hex", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-gh-profile-"));
  const record = join(dir, "calls.jsonl");
  const bin = fakeGh(`import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(record)},"x\\n"); process.stdout.write(JSON.stringify({head:{sha:"${"ab".repeat(32)}"}}));`);
  const gh = new GithubGh({ bin });
  try {
    await expect(gh.observePullRequest({ owner: "a", repo: "b", pr: 7, perPage: 100 })).rejects.toThrow("GitHub returned invalid pull request head SHA");
    expect(readFileSync(record, "utf8").trim().split("\n")).toHaveLength(1);
  } finally { await gh.close(); }
});

test("a failing pull request read that is not a 404 is a call failure", async () => {
  const bin = fakeGh(`process.stderr.write("HTTP 502: Bad Gateway"); process.exit(1);`);
  const gh = new GithubGh({ bin });
  try {
    await expect(gh.observePullRequest({ owner: "a", repo: "b", pr: 7, perPage: 100 })).rejects.toThrow("GitHub call failed");
  } finally { await gh.close(); }
});

test("a check-runs body that is not the expected JSON is an invalid response", async () => {
  const bin = fakeGh(`const a=process.argv.slice(2); if(a.some((x)=>x.endsWith("/pulls/7"))) process.stdout.write(JSON.stringify({head:{sha:"${HEAD40}"}})); else process.stdout.write("<html>");`);
  const gh = new GithubGh({ bin });
  try {
    await expect(gh.observePullRequest({ owner: "a", repo: "b", pr: 7, perPage: 100 })).rejects.toThrow("GitHub returned invalid check runs");
  } finally { await gh.close(); }
});

test("parses a check-runs page larger than the display cap", async () => {
  const bin = fakeGh(`const a=process.argv.slice(2); if(a.some((x)=>x.endsWith("/pulls/7"))) process.stdout.write(JSON.stringify({head:{sha:"${HEAD40}"},body:"x".repeat(100000)})); else process.stdout.write(JSON.stringify({total_count:100,check_runs:Array.from({length:100},(_, i)=>({name:"ci"+i,status:"completed",conclusion:"success",html_url:null,output:{text:"y".repeat(2000)}}))}));`);
  const gh = new GithubGh({ bin });
  try {
    const result = await gh.observePullRequest({ owner: "a", repo: "b", pr: 7, perPage: 100 });
    expect(result).toMatchObject({ outcome: "read", observedHeadSha: HEAD40, truncated: false });
    expect(result.outcome === "read" && result.checkRuns).toHaveLength(100);
  } finally { await gh.close(); }
});

test("a response over the observation limit is an invalid response, not a cut-off parse", async () => {
  const bin = fakeGh(`const a=process.argv.slice(2); if(a.some((x)=>x.endsWith("/pulls/7"))) process.stdout.write(JSON.stringify({head:{sha:"${HEAD40}"}})); else process.stdout.write(JSON.stringify({total_count:1,check_runs:[{name:"ci",status:"completed",conclusion:"success",output:{text:"y".repeat(300000)}}]}));`);
  const gh = new GithubGh({ bin, observeLimitBytes: 200_000 });
  try {
    await expect(gh.observePullRequest({ owner: "a", repo: "b", pr: 7, perPage: 100 })).rejects.toThrow(/^GitHub returned invalid/);
  } finally { await gh.close(); }
});
