"""
Prediction Models
-----------------
1. DNNModel     — Deep Neural Network with dropout (Keras/TensorFlow)
2. PatternModel — Cosine-similarity based pattern matching (k-NN over races)
3. Both output per-horse win probabilities for a given race.
"""

import os
import pickle
import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple

# TF is imported lazily so the file can be imported without TF installed
_tf = None
_keras = None

def _get_tf():
    global _tf, _keras
    if _tf is None:
        import tensorflow as tf
        _tf = tf
        _keras = tf.keras
    return _tf, _keras

from .features import get_feature_columns, get_categorical_columns, get_numerical_columns


# ---------------------------------------------------------------------------
# Deep Neural Network Model
# ---------------------------------------------------------------------------

class DNNModel:
    """
    Binary classifier trained per-horse.
    Output: P(horse wins race).  Pick argmax within a race for prediction.

    Architecture:
        [Dense(256, relu) → BN → Dropout(0.3)]
        [Dense(128, relu) → BN → Dropout(0.3)]
        [Dense(64,  relu) → BN → Dropout(0.2)]
        Dense(1, sigmoid)
    """

    def __init__(
        self,
        hidden_units:          Tuple[int, ...] = (256, 128, 64),
        dropout_rates:         Tuple[float, ...] = (0.3, 0.3, 0.2),
        embedding_dim:         int   = 4,
        confidence_threshold:  float = 0.80,
        winner_weight:         float = 2.5,
    ):
        self.hidden_units         = hidden_units
        self.dropout_rates        = dropout_rates
        self.embedding_dim        = embedding_dim
        self.confidence_threshold = confidence_threshold
        self.winner_weight        = winner_weight
        self.model = None
        self._cat_vocab: Dict[str, int] = {}

    # ── build ─────────────────────────────────────────────────────────────────

    def _build(self, n_num: int) -> None:
        _, keras = _get_tf()
        layers = keras.layers

        num_input = keras.Input(shape=(n_num,), name="numerical")
        x = num_input

        cat_inputs    = []
        cat_embedded  = []
        for col in get_categorical_columns():
            vocab = self._cat_vocab.get(col, 32)
            inp = keras.Input(shape=(1,), name=col, dtype="int32")
            emb = layers.Embedding(vocab + 1, self.embedding_dim, name=f"emb_{col}")(inp)
            emb = layers.Flatten()(emb)
            cat_inputs.append(inp)
            cat_embedded.append(emb)

        if cat_embedded:
            x = layers.Concatenate()([num_input] + cat_embedded)

        for units, drop in zip(self.hidden_units, self.dropout_rates):
            x = layers.Dense(units, activation="relu")(x)
            x = layers.BatchNormalization()(x)
            x = layers.Dropout(drop)(x)

        output = layers.Dense(1, activation="sigmoid", name="win_prob")(x)

        self.model = keras.Model(inputs=[num_input] + cat_inputs, outputs=output)
        self.model.compile(
            optimizer=keras.optimizers.Adam(learning_rate=1e-3),
            loss="binary_crossentropy",
            metrics=["AUC"],
        )

    # ── fit ───────────────────────────────────────────────────────────────────

    def fit(self, df: pd.DataFrame, epochs: int = 300,
            batch_size: int = 512, verbose: int = 0,
            checkpoint_path: str = None) -> None:
        num_cols = get_numerical_columns()
        cat_cols = get_categorical_columns()

        # Build vocab sizes from training data
        for col in cat_cols:
            if col in df.columns:
                col_max = pd.to_numeric(df[col], errors="coerce").max()
                self._cat_vocab[col] = int(col_max + 1) if not np.isnan(col_max) else 1

        self._build(len(num_cols))

        X_num = df[num_cols].fillna(0).values.astype(np.float32)
        X_cat = {
            col: df[col].fillna(0).values.astype(np.int32).reshape(-1, 1)
            for col in cat_cols
        }
        y = df["won"].values.astype(np.float32)
        sample_weights = np.where(y == 1, self.winner_weight, 1.0)

        _, keras = _get_tf()
        callbacks = [
            keras.callbacks.EarlyStopping(
                monitor="val_loss", patience=30, restore_best_weights=True
            ),
            keras.callbacks.ReduceLROnPlateau(
                monitor="val_loss", factor=0.5, patience=15, min_lr=1e-5
            ),
        ]
        if checkpoint_path:
            os.makedirs(os.path.dirname(checkpoint_path) or ".", exist_ok=True)
            callbacks.append(
                keras.callbacks.ModelCheckpoint(
                    checkpoint_path, monitor="loss",
                    save_best_only=True, verbose=0,
                )
            )

        self.model.fit(
            [X_num] + [X_cat[c] for c in cat_cols],
            y,
            sample_weight=sample_weights,
            epochs=epochs,
            batch_size=batch_size,
            validation_split=0.2,
            callbacks=callbacks,
            verbose=verbose,
        )

    # ── predict ───────────────────────────────────────────────────────────────

    def predict_race(self, race_df: pd.DataFrame) -> np.ndarray:
        """Returns array of win probabilities (one per horse), summing to 1."""
        num_cols = get_numerical_columns()
        cat_cols = get_categorical_columns()

        X_num = race_df[num_cols].fillna(0).values.astype(np.float32)
        X_cat = {
            col: race_df[col].fillna(0).values.astype(np.int32).reshape(-1, 1)
            for col in cat_cols
        }
        probs = self.model.predict(
            [X_num] + [X_cat[c] for c in cat_cols], verbose=0
        ).flatten()
        probs = np.clip(probs, 1e-9, 1.0)
        return probs / probs.sum()

    def should_bet(self, race_df: pd.DataFrame) -> Tuple[Optional[int], float]:
        """Returns (best_horse_idx, confidence) or (None, 0) if below threshold."""
        probs      = self.predict_race(race_df)
        best_idx   = int(np.argmax(probs))
        confidence = float(probs[best_idx])
        if confidence >= self.confidence_threshold:
            return best_idx, confidence
        return None, confidence

    # ── persistence ───────────────────────────────────────────────────────────

    def save(self, path: str) -> None:
        os.makedirs(path, exist_ok=True)
        self.model.save(os.path.join(path, "dnn_model.keras"))
        meta = {
            "hidden_units":         self.hidden_units,
            "dropout_rates":        self.dropout_rates,
            "embedding_dim":        self.embedding_dim,
            "confidence_threshold": self.confidence_threshold,
            "winner_weight":        self.winner_weight,
            "cat_vocab":            self._cat_vocab,
        }
        with open(os.path.join(path, "dnn_meta.pkl"), "wb") as f:
            pickle.dump(meta, f)

    @classmethod
    def load(cls, path: str) -> "DNNModel":
        _, keras = _get_tf()
        with open(os.path.join(path, "dnn_meta.pkl"), "rb") as f:
            meta = pickle.load(f)
        obj = cls(**{k: v for k, v in meta.items() if k != "cat_vocab"})
        obj._cat_vocab = meta["cat_vocab"]
        obj.model = keras.models.load_model(os.path.join(path, "dnn_model.keras"))
        return obj


# ---------------------------------------------------------------------------
# Pattern Matching Model
# ---------------------------------------------------------------------------

class PatternModel:
    """
    Cosine-similarity k-NN over race vectors.
    Finds the k most similar historical races and uses their outcomes
    (soft-voted, EMA-weighted by recency) to estimate win probabilities.
    """

    def __init__(self, k: int = 12, recency_decay: float = 0.99):
        self.k             = k
        self.recency_decay = recency_decay
        self._index: List[dict] = []
        self._num_cols = get_numerical_columns()

    # ── build index ───────────────────────────────────────────────────────────

    def build_index(self, df: pd.DataFrame) -> None:
        self._index = []
        for _, race_df in df.groupby(["date", "location", "race_no"], sort=True):
            vec = self._race_vector(race_df)
            winner_rows = race_df[race_df["won"] == 1]
            if vec is None or winner_rows.empty:
                continue
            winner_draw = (
                int(winner_rows["draw"].iloc[0])
                if "draw" in winner_rows.columns else -1
            )
            winner_vec = (
                race_df.loc[winner_rows.index[0], self._num_cols]
                .fillna(0).infer_objects(copy=False).values.astype(np.float32)
            )
            self._index.append({
                "vec":         vec,
                "winner_draw": winner_draw,
                "winner_vec":  winner_vec,
                "date":        race_df["date"].iloc[0],
                "race_df":     race_df[self._num_cols].fillna(0).infer_objects(copy=False).values.astype(np.float32),
                "won":         race_df["won"].values,
            })

    # ── predict ───────────────────────────────────────────────────────────────

    def predict_race(self, race_df: pd.DataFrame) -> np.ndarray:
        query_vec = self._race_vector(race_df)
        n = len(race_df)
        if query_vec is None or not self._index:
            return np.full(n, 1.0 / n)

        sims = np.array([_cosine_sim(query_vec, e["vec"]) for e in self._index])

        now_idx     = len(self._index)
        age_weights = np.array([self.recency_decay ** (now_idx - i)
                                 for i in range(len(self._index))])
        weighted    = sims * age_weights

        k       = min(self.k, len(self._index))
        top_k   = np.argpartition(weighted, -k)[-k:]

        scores      = np.zeros(n)
        query_vecs  = race_df[self._num_cols].fillna(0).infer_objects(copy=False).values.astype(np.float32)

        for idx in top_k:
            entry    = self._index[idx]
            sim      = float(weighted[idx])
            hist_vecs = entry["race_df"]
            hist_won  = entry["won"]
            for q_i in range(n):
                best_match = int(np.argmax([
                    _cosine_sim(query_vecs[q_i], hist_vecs[h_j])
                    for h_j in range(len(hist_vecs))
                ]))
                scores[q_i] += sim * hist_won[best_match]

        scores = scores + 0.1   # Laplace smoothing
        return scores / scores.sum()

    # ── helpers ───────────────────────────────────────────────────────────────

    def _race_vector(self, race_df: pd.DataFrame) -> Optional[np.ndarray]:
        sub = race_df[self._num_cols].fillna(0)
        if sub.empty:
            return None
        return sub.values.mean(axis=0).astype(np.float32)

    # ── persistence ───────────────────────────────────────────────────────────

    def save(self, path: str) -> None:
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, "pattern_model.pkl"), "wb") as f:
            pickle.dump({
                "k": self.k, "recency_decay": self.recency_decay,
                "index": self._index, "num_cols": self._num_cols,
            }, f)

    @classmethod
    def load(cls, path: str) -> "PatternModel":
        with open(os.path.join(path, "pattern_model.pkl"), "rb") as f:
            data = pickle.load(f)
        obj = cls(k=data["k"], recency_decay=data["recency_decay"])
        obj._index    = data["index"]
        obj._num_cols = data["num_cols"]
        return obj


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom < 1e-9:
        return 0.0
    return float(np.dot(a, b) / denom)
