from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class User(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, from_attributes=True)

    id: int
    username: str = Field(pattern=r"^[a-z0-9_]{3,20}$")
    email: str
    tags: list[str] = Field(min_length=1)
    nickname: Optional[str] = None

    @field_validator("email")
    @classmethod
    def lower_email(cls, v: str) -> str:
        return v.lower()


class Booking(BaseModel):
    start: datetime
    end: datetime

    @model_validator(mode="after")
    def check_order(self):
        if self.end <= self.start:
            raise ValueError("end must be after start")
        return self


def parse_user(data: dict) -> User:
    return User.model_validate(data)


def user_to_dict(user: User) -> dict:
    return user.model_dump()


def user_to_json(user: User) -> str:
    return user.model_dump_json()


def user_from_obj(obj) -> User:
    return User.model_validate(obj)
