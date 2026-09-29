from __future__ import annotations

import typing

import pydantic


class Cat(pydantic.BaseModel):
    pet_type: typing.Literal["cat"] = pydantic.Field(alias="petType")
    meow_volume: int = pydantic.Field(alias="meowVolume")
    model_config = pydantic.ConfigDict(populate_by_name=True)


class Dog(pydantic.BaseModel):
    pet_type: typing.Literal["dog"] = pydantic.Field(alias="petType")
    bark_volume: int = pydantic.Field(alias="barkVolume")
    model_config = pydantic.ConfigDict(populate_by_name=True)


Pet = pydantic.RootModel[typing.Annotated[typing.Union[Cat, Dog], pydantic.Field(discriminator="pet_type")]]
