from langchain.agents import create_agent
from langchain.tools import tool
from langchain_openai import ChatOpenAI


@tool
def get_weather(city: str) -> str:
    """Get the weather for a city."""
    return f"It is sunny in {city}."


@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


def build_agent():
    return create_agent(
        model=ChatOpenAI(model="gpt-4o-mini"),
        tools=[get_weather, add],
        system_prompt="You are a helpful assistant.",
    )


def ask(question: str) -> str:
    result = build_agent().invoke({"messages": [{"role": "user", "content": question}]})
    return result["messages"][-1].content
