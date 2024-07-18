backupApp.service('ServerStatus', function ($rootScope, $timeout, AppService, AppUtils, gettextCatalog) {

    var longpolltime = 5 * 60 * 1000;

    var waitingfortask = {};

    var state = {
        lastEventId: -1,
        lastDataUpdateId: -1,
        lastNotificationUpdateId: -1,
        estimatedPauseEnd: new Date("0001-01-01T00:00:00"),
        activeTask: null,
        programState: null,
        lastErrorMessage: null,
        connectionState: 'connected',
        connectionAttemptTimer: 0,
        failedConnectionAttempts: 0,
        lastPgEvent: null,
        updaterState: 'waiting',
        updateDownloadLink: null,
        updatedVersion: null,
        updateDownloadProgress: 0,
        proposedSchedule: [],
        schedulerQueueIds: []
    };

    this.state = state;
    var self = this;

    function reloadTexts() {
        self.progress_state_text = {
            'Backup_Begin': gettextCatalog.getString('Starting backup …'),
            'Backup_PreBackupVerify': gettextCatalog.getString('Verifying backend data …'),
            'Backup_PostBackupTest': gettextCatalog.getString('Verifying remote data …'),
            'Backup_PreviousBackupFinalize': gettextCatalog.getString('Completing previous backup …'),
            'Backup_ProcessingFiles': null,
            'Backup_Finalize': gettextCatalog.getString('Completing backup …'),
            'Backup_WaitForUpload': gettextCatalog.getString('Waiting for upload to finish …'),
            'Backup_Delete': gettextCatalog.getString('Deleting unwanted files …'),
            'Backup_Compact': gettextCatalog.getString('Compacting remote data ...'),
            'Backup_VerificationUpload': gettextCatalog.getString('Uploading verification file …'),
            'Backup_PostBackupVerify': gettextCatalog.getString('Verifying backend data …'),
            'Backup_Complete': gettextCatalog.getString('Backup complete!'),
            'Restore_Begin': gettextCatalog.getString('Starting restore …'),
            'Restore_RecreateDatabase': gettextCatalog.getString('Rebuilding local database …'),
            'Restore_PreRestoreVerify': gettextCatalog.getString('Verifying remote data …'),
            'Restore_CreateFileList': gettextCatalog.getString('Building list of files to restore …'),
            'Restore_CreateTargetFolders': gettextCatalog.getString('Creating target folders …'),
            'Restore_ScanForExistingFiles': gettextCatalog.getString('Scanning existing files …'),
            'Restore_ScanForLocalBlocks': gettextCatalog.getString('Scanning for local blocks …'),
            'Restore_PatchWithLocalBlocks': gettextCatalog.getString('Patching files with local blocks …'),
            'Restore_DownloadingRemoteFiles': gettextCatalog.getString('Downloading files …'),
            'Restore_PostRestoreVerify': gettextCatalog.getString('Verifying restored files …'),
            'Restore_Complete': gettextCatalog.getString('Restore complete!'),
            'Recreate_Running': gettextCatalog.getString('Recreating database …'),
            'Vacuum_Running': gettextCatalog.getString('Vacuuming database …'),
            'Repair_Running': gettextCatalog.getString('Repairing database …'),
            'Verify_Running': gettextCatalog.getString('Verifying files …'),
            'BugReport_Running': gettextCatalog.getString('Creating bug report …'),
            'Delete_Listing': gettextCatalog.getString('Listing remote files …'),
            'Delete_Deleting': gettextCatalog.getString('Deleting remote files …'),
            'PurgeFiles_Begin,': gettextCatalog.getString('Listing remote files for purge …'),
            'PurgeFiles_Process,': gettextCatalog.getString('Purging files …'),
            'PurgeFiles_Compact,': gettextCatalog.getString('Compacting remote data …'),
            'PurgeFiles_Complete,': gettextCatalog.getString('Purging files complete!'),
            'Error': gettextCatalog.getString('Error!')
        };
    };

    reloadTexts();
    $rootScope.$on('gettextLanguageChanged', reloadTexts);

    this.watch = function (scope, m) {
        scope.$on('serverstatechanged', function () {
            $timeout(function () {
                if (m) m();
                scope.$digest();
            });
        });

        if (m) $timeout(m);
        return state;
    }

    this.resume = function () {
        return AppService.post('/serverstate/resume');
    };

    this.pause = function (duration) {
        return AppService.post('/serverstate/pause' + (duration == null ? '' : '?duration=' + duration));
    };

    this.callWhenTaskCompletes = function (taskid, callback) {
        if (waitingfortask[taskid] == null)
            waitingfortask[taskid] = [];
        waitingfortask[taskid].push(callback);
    };

    var lastTaskId = null;
    $rootScope.$on('serverstatechanged.activeTask', function () {
        var currentTaskId = state.activeTask == null ? null : state.activeTask.Item1;

        if (lastTaskId != null && currentTaskId != lastTaskId && waitingfortask[lastTaskId] != null) {
            for (var i in waitingfortask[lastTaskId])
                waitingfortask[lastTaskId][i]();
            delete waitingfortask[lastTaskId];
        }

        lastTaskId = currentTaskId;
    });

    var progressPollTimer = null;
    var progressPollInProgress = false;
    var progressPollWait = 2000;

    function startUpdateProgressPoll() {
        if (progressPollInProgress)
            return;

        if (state.activeTask == null) {
            if (progressPollTimer != null)
                clearTimeout(progressPollTimer);
            progressPollTimer = null;
            state.lastPgEvent = null;
        } else {
            progressPollInProgress = true;

            if (progressPollTimer != null)
                clearTimeout(progressPollTimer);
            progressPollTimer = null;

            AppService.get('/progressstate').then(
                function (resp) {
                    state.lastPgEvent = resp.data;
                    progressPollInProgress = false;
                    progressPollTimer = setTimeout(startUpdateProgressPoll, progressPollWait);
                },

                function (resp) {
                    progressPollInProgress = false;
                    progressPollTimer = setTimeout(startUpdateProgressPoll, progressPollWait);
                }
            );
        }
    };

    let websocketReconnectTimer = null;
    const countdownForReconnect = function (m) {
        if (websocketReconnectTimer != null) {
            window.clearInterval(websocketReconnectTimer);
            websocketReconnectTimer = null;
        }

        const retryAt = new Date(new Date().getTime() + 15000);
        state.connectionAttemptTimer = new Date() - retryAt;
        $rootScope.$broadcast('serverstatechanged');

        websocketReconnectTimer = window.setInterval(function () {
            state.connectionAttemptTimer = retryAt - new Date();
            if (state.connectionAttemptTimer <= 0)
                m();
            else {
                $rootScope.$broadcast('serverstatechanged');
            }
        }, 1000);
    };

    var updatepausetimer = null;

    function pauseTimerUpdater(skipNotify) {
        var prev = state.pauseTimeRemain;

        state.pauseTimeRemain = Math.max(0, AppUtils.parseDate(state.estimatedPauseEnd) - new Date());
        if (state.pauseTimeRemain > 0 && updatepausetimer == null) {
            updatepausetimer = setInterval(pauseTimerUpdater, 5000);
        } else if (state.pauseTimeRemain <= 0 && updatepausetimer != null) {
            clearInterval(updatepausetimer);
            updatepausetimer = null;
        }

        if (prev != state.pauseTimeRemain && !skipNotify)
            $rootScope.$broadcast('serverstatechanged.pauseTimeRemain', state.pauseTimeRemain);

        return prev != state.pauseTimeRemain;
    }

    var notifyIfChanged = function (data, dataname, varname) {
        if (state[varname] != data[dataname]) {
            if (varname === 'estimatedPauseEnd') {
                state[varname] = new Date(data[dataname]);
            } else {
                state[varname] = data[dataname];
            }
            console.log("state changed: ", "serverstatechanged." + varname)
            $rootScope.$broadcast('serverstatechanged.' + varname, state[varname]);
            return true;
        }

        return false;
    }

    function handleServerState(response) {
        var oldEventId = state.lastEventId;
        var anychanged =
            notifyIfChanged(response.data, 'LastEventID', 'lastEventId') |
            notifyIfChanged(response.data, 'LastDataUpdateID', 'lastDataUpdateId') |
            notifyIfChanged(response.data, 'LastNotificationUpdateID', 'lastNotificationUpdateId') |
            notifyIfChanged(response.data, 'ActiveTask', 'activeTask') |
            notifyIfChanged(response.data, 'ProgramState', 'programState') |
            notifyIfChanged(response.data, 'EstimatedPauseEnd', 'estimatedPauseEnd') |
            notifyIfChanged(response.data, 'UpdaterState', 'updaterState') |
            notifyIfChanged(response.data, 'UpdateDownloadLink', 'updateDownloadLink') |
            notifyIfChanged(response.data, 'UpdatedVersion', 'updatedVersion') |
            notifyIfChanged(response.data, 'UpdateDownloadProgress', 'updateDownloadProgress');


        if (!angular.equals(state.proposedSchedule, response.data.ProposedSchedule)) {
            state.proposedSchedule.length = 0;
            state.proposedSchedule.push.apply(state.proposedSchedule, response.data.ProposedSchedule);
            $rootScope.$broadcast('serverstatechanged.proposedSchedule', state.proposedSchedule);
            anychanged = true;
        }

        if (!angular.equals(state.schedulerQueueIds, response.data.SchedulerQueueIds)) {
            state.schedulerQueueIds.length = 0;
            state.schedulerQueueIds.push.apply(state.schedulerQueueIds, response.data.SchedulerQueueIds);
            $rootScope.$broadcast('serverstatechanged.schedulerQueueIds', state.schedulerQueueIds);
            anychanged = true;
        }

        // Clear error indicators
        state.failedConnectionAttempts = 0;

        if (state.connectionState != 'connected') {
            state.connectionState = 'connected';
            $rootScope.$broadcast('serverstatechanged.connectionState', state.connectionState);
            anychanged = true;

            // Reload page, server restarted
            if (oldEventId > state.lastEventId)
                location.reload(true);
        }

        anychanged |= pauseTimerUpdater(true);

        if (anychanged)
            $rootScope.$broadcast('serverstatechanged');

        if (state.activeTask != null)
            startUpdateProgressPoll();
    }

    const webSocketUnauthorizedCode = 4401;
    const unauthorizedCode = 401;

    function handleConnectionError(response) {
        state.failedConnectionAttempts++;

        // First failure, we ignore
        if (state.connectionState == 'connected' && state.failedConnectionAttempts == 1) {
            updateServerState();
        } else if (response.status === webSocketUnauthorizedCode || response.status === unauthorizedCode) {
            state.connectionState = 'unauthorized';
            $rootScope.$broadcast('serverstatechanged');
        } else {
            state.connectionState = 'disconnected';
            $rootScope.$broadcast('serverstatechanged');
            countdownForReconnect(function () {
                updateServerState();
            });
        }
    }

    var updateServerState = function () {
        if (state.connectionState !== 'connected') {
            state.connectionState = 'connecting';
            $rootScope.$broadcast('serverstatechanged');
        }

        self.reconnect();
    };

    const reconnect_websocket = function () {
        window.clearInterval(websocketReconnectTimer);
        const w = new WebSocket(`ws://${window.location.host}/notifications?token=${AppService.access_token}`)
        w.addEventListener("message", (event) => {
            const status = JSON.parse(event.data);
            handleServerState({data: status});
        });
        w.addEventListener("close", (event) => {
            window.websocket = null;
            if (event.code === webSocketUnauthorizedCode)
                AppService.clearAccessToken();

            handleConnectionError({status: event.code});
        });
        return w;
    };

    this.reconnect = function () {
        AppService.getAccessToken().then(() => {
            window.websocket = reconnect_websocket();
        }, resp => {
            handleConnectionError(resp);
        });
    }

    this.reconnect();

});
