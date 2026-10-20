/**
 * EdgeOne Pages project configuration.
 *
 * The critical setting is `outputDirectory`: EdgeOne Pages needs a static
 * artifact to serve as the site root, otherwise the deployment is treated
 * as an empty site and every request returns "The site does not exist."
 *
 * Edge functions live in ./functions and are picked up automatically.
 * No install or build step is required.
 */
const config = {
  outputDirectory: 'public',
};

export default config;
