import pandas as pd


def adults(df: pd.DataFrame) -> pd.DataFrame:
    kept = df.filter(cond=pd.col("age") >= 18)
    kept = kept.sort_values("age").reset_index(drop=True)
    return kept.select("name", age_months=pd.col("age") * 12)
