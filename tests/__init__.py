import warnings


warnings.filterwarnings(
    "error",
    category=DeprecationWarning,
    module=r"^(?:(?:PIL|mozarie|tests)(?:\.|$)|server$|updater$)",
)
