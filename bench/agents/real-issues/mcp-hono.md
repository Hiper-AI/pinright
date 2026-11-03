This library is currently fairly heavily dependent on Express and other associated libraries (`raw-body`, `content-type`), which adds challenges to running it in non-Node.js environments like Cloudflare Workers, Deno, Bun, etc. Other users have raised this too (#383)

While I would love to get rid of these dependencies and make this library just use Request/Response signatures (which can also run in Node.js), I realize that's probably a big ask at this stage.

Would you consider instead including some examples/documentation on running with [Hono](https://hono.dev/) – a runtime-agnostic JS server with a familiar feel to Express?

I have an example based off the examples in this library: https://github.com/mhart/mcp-hono-stateless

It uses a library to convert from Request/Response to Node.js req/res, so perhaps not my ideal state, but doesn't require any changes to this library.
