from pathlib import Path

from langchain.agents import create_agent
from langchain.mcp import MCPAdapter
from langchain_openai import ChatOpenAI

SERVER = Path(__file__).with_name("weather_server.py")


async def ask(question: str) -> str:
    async with MCPAdapter(SERVER) as adapter:
        tools = await adapter.list_tools()
        agent = create_agent(ChatOpenAI(model="gpt-4o-mini"), tools)
        result = await agent.ainvoke({"messages": [{"role": "user", "content": question}]})
        return result["messages"][-1].text
