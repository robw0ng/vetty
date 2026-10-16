// Aggregator: one `require('./core')` for the plumbing modules. Each of them only lazy-requires the
// view modules (tree/comments/search) inside functions, so there are no top-level cycles.
module.exports = {
  ...require('./app'),
  ...require('./git'),
  ...require('./review-state'),
  ...require('./base'),
  ...require('./guided'),
  ...require('./content'),
};
