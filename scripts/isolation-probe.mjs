const credentialVariables = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "AZURE_FEDERATED_TOKEN_FILE",
  "GITHUB_APP_PRIVATE_KEY",
];

const exposed = credentialVariables.filter((name) => process.env[name]);

if (exposed.length) {
  console.error(`Build job exposed credential variables: ${exposed.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("No platform credential or OIDC token variables are available to build code.");
}