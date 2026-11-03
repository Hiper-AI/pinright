from fastmcp import FastMCP

mcp = FastMCP("weather")


@mcp.tool
def get_weather(city: str) -> str:
    """Get the current weather for a city."""
    return f"{city}: 21 C and sunny"


if __name__ == "__main__":
    mcp.run()
