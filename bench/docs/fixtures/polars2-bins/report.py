import polars as pl


def age_report(people: pl.DataFrame, cities: pl.DataFrame) -> pl.DataFrame:
    return (
        people.with_columns(
            pl.col("age")
            .bin_intervals([12, 19], labels=["child", "teen", "adult"], right_closed=True)
            .alias("age_group"),
            pl.col("income").bin_quantiles(4, labels=False).alias("income_quartile"),
        )
        .join(cities, on="city_id", how="left", nulls_equal=True)
        .with_row_index("row", offset=1)
    )
