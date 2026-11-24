const credentialVariables = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "AZURE_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
];

const exposed = credentialVariables.filter((name) => process.env[name]);

if (exposed.length) {
  console.error(`Build job exposed credential variables: ${exposed.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("No platform credential or OIDC token variables are available to build code.");
}