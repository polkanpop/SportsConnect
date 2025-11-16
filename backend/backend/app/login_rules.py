import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict

logger = logging.getLogger("login_rules")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter('[LOGIN_RULE] %(asctime)s %(levelname)s %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
logger.setLevel(logging.DEBUG)


@dataclass
class UserLoginState:
    consecutive_failures: int = 0
    last_failed_password: str | None = None
    repeat_same_password_count: int = 0  # consecutive repeats of SAME wrong password
    general_cycle_stage: int = 0  # 0 none, 1=5m, 2=30m, 3=24h
    general_cycle_started_at: datetime | None = None
    repeated_password_stage: str = "none"  # none, warn2, 5m, 24h
    repeated_stage_started_at: datetime | None = None

    def reset(self):
        self.consecutive_failures = 0
        self.last_failed_password = None
        self.repeat_same_password_count = 0
        self.general_cycle_stage = 0
        self.general_cycle_started_at = None
        self.repeated_password_stage = "none"
        self.repeated_stage_started_at = None


_states: Dict[int, UserLoginState] = {}


def _get_state(userid: int) -> UserLoginState:
    st = _states.get(userid)
    if not st:
        st = UserLoginState()
        _states[userid] = st
    return st


def _now() -> datetime:
    return datetime.utcnow()


def record_login_attempt(userid: int, attempted_password: str, success: bool) -> None:
    """Record a login attempt for rules. ONLY LOGS; does not enforce blocking.

    Progressive failure cycle (general):
      - 5 consecutive failures => propose 5m timeout
      - +5 (10 total) failures => propose 30m timeout
      - +5 (15 total) failures => propose 24h timeout then reset after expiry

    Repeated identical wrong password cycle (spam detection):
      - 2 consecutive same wrong => notify already typed
      - 3 consecutive same wrong => propose 5m timeout (spam)
      - After 5m hypothetical window, if an additional 2 repeats of SAME wrong arrive (total 5) => propose 24h ignore
      - If user subsequently accumulates 5 general failures AFTER the 3 identical stage, escalate general cycle (30m, 24h) using same counters.

    On success: reset all counters.
    """
    st = _get_state(userid)

    # If prior 24h general stage hypothetically expired, reset cycle.
    if st.general_cycle_stage == 3 and st.general_cycle_started_at:
        if _now() >= st.general_cycle_started_at + timedelta(hours=24):
            logger.info(f"userid={userid} general 24h window finished -> resetting cycle")
            st.reset()

    # If prior repeated-password 24h stage expired, reset repeated stage (keep general failures).
    if st.repeated_password_stage == "24h" and st.repeated_stage_started_at:
        if _now() >= st.repeated_stage_started_at + timedelta(hours=24):
            logger.info(f"userid={userid} repeated-password 24h window finished -> resetting repeated stage")
            st.repeated_password_stage = "none"
            st.repeated_stage_started_at = None
            st.repeat_same_password_count = 0
            st.last_failed_password = None

    if success:
        if st.consecutive_failures or st.repeat_same_password_count or st.general_cycle_stage or st.repeated_password_stage != "none":
            logger.info(f"userid={userid} SUCCESS resets counters prev_consecutive={st.consecutive_failures} prev_general_stage={st.general_cycle_stage} prev_repeated_stage={st.repeated_password_stage}")
        st.reset()
        return

    # FAILURE path
    st.consecutive_failures += 1

    if st.last_failed_password == attempted_password:
        st.repeat_same_password_count += 1
    else:
        st.last_failed_password = attempted_password
        st.repeat_same_password_count = 1

    # Repeated identical wrong password rules
    if st.repeat_same_password_count == 2 and st.repeated_password_stage == "none":
        st.repeated_password_stage = "warn2"
        logger.warning(f"userid={userid} repeated_password=2 -> notify 'You have typed this password already.'")
    elif st.repeat_same_password_count == 3 and st.repeated_password_stage in {"warn2", "none"}:
        st.repeated_password_stage = "5m"
        st.repeated_stage_started_at = _now()
        logger.warning(f"userid={userid} repeated_password=3 -> propose 5m timeout (spam same password) [LOG ONLY]")
    # Immediate trigger when same wrong password has been typed 5 times in a row
    elif st.repeat_same_password_count == 5:
        # Regardless of previous repeated_password_stage/timing, log an immediate ignore proposal.
        st.repeated_password_stage = "24h"
        st.repeated_stage_started_at = _now()
        logger.error(f"userid={userid} repeated_password=5 -> IGNORE API request from this source for 24h (proposed) [LOG ONLY]")
        # Keep logging snapshot for visibility
        logger.debug(
            f"userid={userid} immediate_trigger rptSame={st.repeat_same_password_count} genStage={st.general_cycle_stage}"
        )

    # General consecutive failure cycle
    if st.consecutive_failures in (5, 10, 15):
        stage_map = {5: (1, "5m"), 10: (2, "30m"), 15: (3, "24h")}
        new_stage, label = stage_map[st.consecutive_failures]
        if new_stage > st.general_cycle_stage:
            st.general_cycle_stage = new_stage
            st.general_cycle_started_at = _now()
            logger.warning(
                f"userid={userid} consecutive_failures={st.consecutive_failures} -> propose {label} timeout (general cycle) [LOG ONLY]"
            )
            if new_stage == 3:
                logger.error(f"userid={userid} entered 24h general cycle; will reset after expiry (logging only)")

    # Additional escalation path: if repeated-password stage at 5m and general failures reach 10 or 15, we append escalate
    if st.repeated_password_stage == "5m" and st.consecutive_failures in (10, 15):
        # This will already have triggered general cycle logic above; just emit clarifying log
        logger.info(
            f"userid={userid} repeated-password stage + general failures={st.consecutive_failures} -> appended escalation stage={st.general_cycle_stage}"
        )

    logger.debug(
        f"userid={userid} state cf={st.consecutive_failures} rptSame={st.repeat_same_password_count} genStage={st.general_cycle_stage} repStage={st.repeated_password_stage}"
    )


def get_user_state_snapshot(userid: int) -> dict:
    st = _get_state(userid)
    return {
        "consecutive_failures": st.consecutive_failures,
        "repeat_same_password_count": st.repeat_same_password_count,
        "general_cycle_stage": st.general_cycle_stage,
        "repeated_password_stage": st.repeated_password_stage,
        "general_cycle_started_at": st.general_cycle_started_at.isoformat() if st.general_cycle_started_at else None,
        "repeated_stage_started_at": st.repeated_stage_started_at.isoformat() if st.repeated_stage_started_at else None,
    }
