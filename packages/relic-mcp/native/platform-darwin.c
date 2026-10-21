#define _DARWIN_C_SOURCE

#include "platform.h"

#if !defined(__APPLE__) || !defined(__MACH__)
#error "platform-darwin.c may only be compiled for Darwin"
#endif

#if !defined(__x86_64__) && !defined(__aarch64__) && !defined(__arm64__)
#error "secure_open supports only macOS x86-64 and arm64"
#endif

#include <Availability.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#if !defined(__MAC_OS_X_VERSION_MIN_REQUIRED) || __MAC_OS_X_VERSION_MIN_REQUIRED < 150000
#error "secure_open must be built with a macOS 15.0 or newer deployment target"
#endif

#ifndef O_RESOLVE_BENEATH
#error "secure_open requires O_RESOLVE_BENEATH from a macOS 15.0 SDK"
#endif

#ifndef O_NOFOLLOW_ANY
#error "secure_open requires O_NOFOLLOW_ANY from a macOS 15.0 SDK"
#endif

#ifndef ENOTCAPABLE
#error "secure_open requires ENOTCAPABLE from a macOS 15.0 SDK"
#endif

static void relic_set_error(
  struct relic_open_error *error,
  int errno_value,
  const char *syscall_name,
  enum relic_open_reason reason
) {
  error->errno_value = errno_value;
  error->syscall_name = syscall_name;
  error->reason = reason;
}

static int relic_same_directory(int first_fd, int second_fd) {
  struct stat first_stat = {0};
  struct stat second_stat = {0};

  if (fstat(first_fd, &first_stat) != 0) return 0;
  if (fstat(second_fd, &second_stat) != 0) return 0;
  return first_stat.st_dev == second_stat.st_dev && first_stat.st_ino == second_stat.st_ino;
}

static int relic_probe_uncached(struct relic_open_error *error) {
  const int root_flags =
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | O_NOCTTY;
  const int descendant_flags =
    O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOCTTY |
    O_RESOLVE_BENEATH | O_NOFOLLOW_ANY;
  int root_fd = -1;
  int opened_fd = -1;
  int probe_error = 0;

  root_fd = open("/", root_flags);
  if (root_fd < 0) {
    relic_set_error(
      error,
      errno,
      "open confinement probe root",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }

  opened_fd = openat(root_fd, ".", descendant_flags);
  if (opened_fd < 0 || !relic_same_directory(root_fd, opened_fd)) {
    probe_error = opened_fd < 0 ? errno : EINVAL;
    if (opened_fd >= 0) close(opened_fd);
    close(root_fd);
    relic_set_error(
      error,
      probe_error,
      "openat confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }
  close(opened_fd);

  opened_fd = openat(root_fd, "..", descendant_flags);
  if (opened_fd >= 0) {
    close(opened_fd);
    close(root_fd);
    relic_set_error(
      error,
      EINVAL,
      "openat confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }
  if (errno != ENOTCAPABLE) {
    probe_error = errno;
    close(root_fd);
    relic_set_error(
      error,
      probe_error,
      "openat confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }

  opened_fd = openat(root_fd, "/", descendant_flags);
  if (opened_fd >= 0) {
    close(opened_fd);
    close(root_fd);
    relic_set_error(
      error,
      EINVAL,
      "openat confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }
  if (errno != ENOTCAPABLE) {
    probe_error = errno;
    close(root_fd);
    relic_set_error(
      error,
      probe_error,
      "openat confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }

  opened_fd = openat(
    root_fd,
    ".",
    descendant_flags | O_NOFOLLOW
  );
  if (opened_fd >= 0) {
    close(opened_fd);
    close(root_fd);
    relic_set_error(
      error,
      EINVAL,
      "openat confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }
  if (errno != EINVAL) {
    probe_error = errno;
    close(root_fd);
    relic_set_error(
      error,
      probe_error,
      "openat confinement probe",
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }

  close(root_fd);
  return 0;
}

int relic_probe_confined_open(struct relic_open_error *error) {
  static int probe_state = 0;
  static int probe_errno = 0;
  static const char *probe_syscall = "openat confinement probe";

  if (probe_state == 1) return 0;
  if (probe_state == -1) {
    relic_set_error(
      error,
      probe_errno,
      probe_syscall,
      RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE
    );
    return -1;
  }

  if (relic_probe_uncached(error) == 0) {
    probe_state = 1;
    return 0;
  }

  probe_errno = error->errno_value;
  probe_syscall = error->syscall_name;
  probe_state = -1;
  return -1;
}

int relic_open_root(const char *path, struct relic_open_error *error) {
  const int flags =
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NOFOLLOW_ANY | O_CLOEXEC |
    O_NONBLOCK | O_NOCTTY;
  const int fd = open(path, flags);

  if (fd < 0) {
    relic_set_error(error, errno, "open bundle root", RELIC_OPEN_REASON_NONE);
  }
  return fd;
}

int relic_open_descendant(
  int root_fd,
  const char *relative_path,
  struct relic_open_error *error
) {
  const int flags =
    O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOCTTY |
    O_RESOLVE_BENEATH | O_NOFOLLOW_ANY;
  const int fd = openat(root_fd, relative_path, flags);

  if (fd < 0) {
    relic_set_error(error, errno, "openat confined descendant", RELIC_OPEN_REASON_NONE);
  }
  return fd;
}
