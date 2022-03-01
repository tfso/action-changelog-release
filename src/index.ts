//@ts-check
import core = require("@actions/core")
import { context, getOctokit } from "@actions/github";
import { Octokit } from "@octokit/core";
import semver from "semver";

const owner = "tfso";
const repo = context.payload.repository.name;

const run = async () => {
  console.log("Starting release changelog");
  const version = core.getInput("version") || context.ref.replace("refs/tags/", "");
  const githubApiKey = core.getInput("GITHUB_TOKEN") || process.env.GITHUB_TOKEN;

  const octokit = getOctokit(githubApiKey);

  const latestVersion = await getLatestReleaseTag(octokit);
  console.log(`Latest release version ${latestVersion}`);

  if (isReRelease(version, latestVersion)) {
    handleRerelease();
  }
  if (isRollback(version, latestVersion)) {
    await handleRollback(octokit, version);
  }
  if (isRelease(version, latestVersion)) {
    await handleRelease(version, octokit, latestVersion);
  }
};

async function handleRelease(version: string, octokit: Octokit, latestVersion: string) {
  console.log("Release type: release");
  console.log(`Creating release for version ${version}`);
  core.setOutput("release_type", "release");
  const { name, body } = await getNotes(octokit, version, latestVersion);
  const changelogText = transformReleaseNotes(body);
  await createRelease(octokit, changelogText, name, version);
}

async function handleRollback(octokit: Octokit, version: string) {
  console.log("Release type: rollback");
  core.setOutput("release_type", "rollback");

  const latestRelease = await deleteReleases(octokit, version);

  if (semver.lt(latestRelease.tag_name, version)) {
    console.log(`Creating rollback release for version ${version}`);

    const { name, body } = await getNotes(
      octokit,
      version,
      latestRelease.tag_name
    );

    const changelogText = transformReleaseNotes(body);
    await createRelease(octokit, changelogText, name, version);
  }
}

function handleRerelease() {
  console.log("Release type: rerelease");
  core.setOutput("release_type", "release");
}

function isRelease(version: string, latestVersion: string) {
  return semver.gt(version, latestVersion);
}

function isReRelease(version: string, latestVersion: string) {
  return semver.eq(version, latestVersion);
}

function isRollback(version: string, latestVersion: string) {
  return semver.lt(version, latestVersion);
}

/**
 *
 * @returns Latest release after rollback
 */
async function deleteReleases(octokit: Octokit, version: string) {
  const { data: releases } = await octokit.request(
    "GET /repos/{owner}/{repo}/releases",
    {
      owner,
      repo,
    }
  );

  let count = 0;
  for (const release of releases) {
    if (semver.gt(release.tag_name, version)) {
      await deleteRelease(octokit, release.id);
      console.log(`Removed release ${release.tag_name}`);
      count++;
    }
    if (semver.lte(release.tag_name, version)) {
      return release;
    }
  }

  console.log(`Deleted ${count} releases`);
}

async function deleteRelease(octokit: Octokit, id: number): Promise<void> {
  await octokit.request("DELETE /repos/{owner}/{repo}/releases/{release_id}", {
    owner,
    repo,
    release_id: id,
  });
}

async function getLatestReleaseTag(octokit: Octokit): Promise<string> {
  try {const { data } = await octokit.request(
    "GET /repos/{owner}/{repo}/releases/latest",
    {
      owner,
      repo,
    }
  );

  return data.tag_name;
  } catch (error) {
    // There is probably no other relases
    return 'v0.0.0'
  }
}

function transformReleaseNotes(body: string): string {
  const jiraIssueRegex = /([a-z]{3,10}-[0-9]+)/gi;

  let notes = body
    .split("\n")
    .map((line) => {
      const issues = line.match(jiraIssueRegex);
      if (!issues) {
        return line;
      }

      let newLine = line;
      for (const issue of issues) {
        newLine = newLine.replace(issue, "");
      }
      newLine = `${newLine} (${issues.join(" ")})`;

      return newLine;
    })
    .join("\n");

  const releaseNotes = notes.replace(
    jiraIssueRegex,
    (match) => `[${match}](https://24so.atlassian.net/browse/${match})`
  );

  console.log("Final release notes:");
  console.log(releaseNotes);

  return releaseNotes;
}

async function createRelease(octokit: Octokit, changelogText: string, name: string, version: string): Promise<void> {
  await octokit.request("POST /repos/{owner}/{repo}/releases", {
    owner,
    repo,
    body: changelogText,
    name,
    tag_name: version,
  });
}

async function getNotes(octokit: Octokit, version: string, previousVersion: string): Promise<{name: string, body: string}> {
  const {
    data: { name, body },
  } = await octokit.request(
    "POST /repos/{owner}/{repo}/releases/generate-notes",
    {
      owner,
      repo,
      tag_name: version,
      previous_tag_name: previousVersion === 'v0.0.0' ? undefined : previousVersion,
    }
  );

  return { name, body };
}

run();
