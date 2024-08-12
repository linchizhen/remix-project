import { useContext, useEffect, useMemo, useState } from 'react'

import { AppContext } from '../AppContext'
import { SearchableChainDropdown, ContractDropdown, ContractAddressInput } from '../components'
import type { VerifierIdentifier, SubmittedContract, VerificationReceipt, VerifierInfo, VerificationResponse } from '../types'
import { VERIFIERS } from '../types'
import { mergeChainSettingsWithDefaults, validConfiguration } from '../utils'
import { useNavigate } from 'react-router-dom'
import { ConstructorArguments } from '../components/ConstructorArguments'
import { CustomTooltip } from '@remix-ui/helper'
import { AbstractVerifier, getVerifier } from '../Verifiers'
import { VerifyFormContext } from '../VerifyFormContext'
import { useSourcifySupported } from '../hooks/useSourcifySupported'

export const VerifyView = () => {
  const { compilationOutput, setSubmittedContracts, settings } = useContext(AppContext)
  const { selectedChain, setSelectedChain, contractAddress, setContractAddress, contractAddressError, setContractAddressError, selectedContract, setSelectedContract, proxyAddress, setProxyAddress, proxyAddressError, setProxyAddressError, abiEncodedConstructorArgs, setAbiEncodedConstructorArgs, abiEncodingError, setAbiEncodingError } = useContext(VerifyFormContext)
  const [enabledVerifiers, setEnabledVerifiers] = useState<Partial<Record<VerifierIdentifier, boolean>>>({})
  const [hasProxy, setHasProxy] = useState(!!proxyAddress)
  const navigate = useNavigate()

  const chainSettings = useMemo(() => (selectedChain ? mergeChainSettingsWithDefaults(selectedChain.chainId.toString(), settings) : undefined), [selectedChain, settings])

  const sourcifySupported = useSourcifySupported(selectedChain, chainSettings)

  const submitDisabled = !!contractAddressError || !contractAddress || !selectedChain || !selectedContract || (hasProxy && !!proxyAddressError) || (hasProxy && !proxyAddress)

  // Enable all verifiers with valid configuration
  useEffect(() => {
    const changedEnabledVerifiers = {}
    for (const verifierId of VERIFIERS) {
      if (validConfiguration(chainSettings, verifierId) && (verifierId !== 'Sourcify' || sourcifySupported)) {
        changedEnabledVerifiers[verifierId] = true
      }
    }
    setEnabledVerifiers(changedEnabledVerifiers)
  }, [selectedChain, sourcifySupported])

  const handleVerifierCheckboxClick = (verifierId: VerifierIdentifier, checked: boolean) => {
    setEnabledVerifiers({ ...enabledVerifiers, [verifierId]: checked })
  }

  const handleVerify = async (e) => {
    e.preventDefault()

    const { triggerFilePath, filePath, contractName } = selectedContract
    const compilerAbstract = compilationOutput[triggerFilePath]
    if (!compilerAbstract) {
      throw new Error(`Error: Compilation output not found for ${triggerFilePath}`)
    }

    const date = new Date()
    const contractId = selectedChain?.chainId + '-' + contractAddress + '-' + date.toUTCString()
    const receipts: VerificationReceipt[] = []
    for (const [verifierId, enabled] of Object.entries(enabledVerifiers)) {
      if (!enabled) {
        continue
      }

      const verifierInfo: VerifierInfo = {
        apiUrl: chainSettings.verifiers[verifierId].apiUrl,
        name: verifierId as VerifierIdentifier,
      }
      receipts.push({ verifierInfo, status: 'pending', contractId, isProxyReceipt: false, failedChecks: 0 })
    }

    const newSubmittedContract: SubmittedContract = {
      id: contractId,
      address: contractAddress,
      chainId: selectedChain?.chainId.toString(),
      filePath,
      contractName,
      date: date.toUTCString(),
      receipts,
    }
    if (abiEncodedConstructorArgs) {
      newSubmittedContract.abiEncodedConstructorArgs = abiEncodedConstructorArgs
    }

    const proxyReceipts: VerificationReceipt[] = []
    if (hasProxy) {
      for (const [verifierId, enabled] of Object.entries(enabledVerifiers)) {
        if (!enabled) {
          continue
        }

        const verifierSettings = chainSettings.verifiers[verifierId]
        const verifierInfo: VerifierInfo = {
          apiUrl: verifierSettings.apiUrl,
          name: verifierId as VerifierIdentifier,
        }

        let verifier: AbstractVerifier
        try {
          verifier = getVerifier(verifierId as VerifierIdentifier, verifierSettings)
        } catch (e) {
          // User settings might be invalid
          proxyReceipts.push({ verifierInfo, status: 'failed', contractId, isProxyReceipt: true, message: e.message, failedChecks: 0 })
          continue
        }

        if (!verifier.verifyProxy) {
          continue
        }

        proxyReceipts.push({ verifierInfo, status: 'pending', contractId, isProxyReceipt: true, failedChecks: 0 })
      }

      newSubmittedContract.proxyAddress = proxyAddress
      newSubmittedContract.proxyReceipts = proxyReceipts
    }

    setSubmittedContracts((prev) => ({ ...prev, [newSubmittedContract.id]: newSubmittedContract }))

    setContractAddress('')

    // Take user to receipt view
    navigate('/receipts')

    const verify = async (receipt: VerificationReceipt) => {
      if (receipt.status === 'failed') {
        return // failed already when creating
      }

      const { verifierInfo } = receipt
      const verifierSettings = chainSettings.verifiers[verifierInfo.name]
      try {
        const verifier = getVerifier(verifierInfo.name, verifierSettings)
        let response: VerificationResponse
        if (receipt.isProxyReceipt) {
          response = await verifier.verifyProxy(newSubmittedContract)
        } else {
          response = await verifier.verify(newSubmittedContract, compilerAbstract)
        }
        const { status, message, receiptId, lookupUrl } = response
        receipt.status = status
        receipt.message = message
        if (lookupUrl) {
          receipt.lookupUrl = lookupUrl
        }
        if (receiptId) {
          receipt.receiptId = receiptId
        }
      } catch (e) {
        const err = e as Error
        receipt.status = 'failed'
        receipt.message = err.message
      }

      // Update the UI
      setSubmittedContracts((prev) => ({ ...prev, [newSubmittedContract.id]: newSubmittedContract }))
    }

    // Verify for each verifier. forEach does not wait for await and each promise will execute in parallel
    receipts.forEach(verify)
    proxyReceipts.forEach(verify)
  }

  return (
    <form onSubmit={handleVerify}>
      <SearchableChainDropdown label="Chain" id="network-dropdown" selectedChain={selectedChain} setSelectedChain={setSelectedChain} />

      <ContractAddressInput label="Contract Address" id="contract-address" contractAddress={contractAddress} setContractAddress={setContractAddress} contractAddressError={contractAddressError} setContractAddressError={setContractAddressError} />

      <ContractDropdown label="Contract Name" id="contract-dropdown-1" selectedContract={selectedContract} setSelectedContract={setSelectedContract} />

      {selectedContract && <ConstructorArguments abiEncodedConstructorArgs={abiEncodedConstructorArgs} setAbiEncodedConstructorArgs={setAbiEncodedConstructorArgs} selectedContract={selectedContract} abiEncodingError={abiEncodingError} setAbiEncodingError={setAbiEncodingError} />}

      <div className="pt-3 form-check form-switch">
        <input className="form-check-input" type="checkbox" id="has-proxy" checked={!!hasProxy} onChange={(e) => setHasProxy(e.target.checked)} />
        <label className="form-check-label" htmlFor="has-proxy">
          The deployed contract is behind a proxy
        </label>
        {hasProxy && <ContractAddressInput label="Proxy Address" id="proxy-address" contractAddress={proxyAddress} setContractAddress={setProxyAddress} contractAddressError={proxyAddressError} setContractAddressError={setProxyAddressError} />}
      </div>

      <div className="pt-3">
        Verify on:
        {VERIFIERS.map((verifierId) => {
          const disabledVerifier = !chainSettings || !validConfiguration(chainSettings, verifierId) || (verifierId === 'Sourcify' && !sourcifySupported)

          return (
            <div key={verifierId} className="pt-2 form-check">
              <input className="form-check-input" type="checkbox" id={`verifier-${verifierId}`} checked={!!enabledVerifiers[verifierId]} onChange={(e) => handleVerifierCheckboxClick(verifierId, e.target.checked)} disabled={disabledVerifier} />

              <div className="d-flex flex-column align-items-start">
                <label htmlFor={`verifier-${verifierId}`} style={{ fontSize: '1rem', lineHeight: '1.5', color: 'var(--text)' }} className={`mb-0 font-weight-bold${!disabledVerifier ? '' : ' text-secondary'}`}>
                  {verifierId}
                </label>
                {!chainSettings ? (
                  ''
                ) : !validConfiguration(chainSettings, verifierId) ? (
                  <CustomTooltip tooltipText="Configure the API in the settings">
                    <span className="text-secondary w-auto" style={{ textDecoration: 'underline dotted', cursor: 'pointer' }} onClick={() => navigate('/settings')}>
                      Enable?
                    </span>
                  </CustomTooltip>
                ) : verifierId === 'Sourcify' && !sourcifySupported ? (
                  <CustomTooltip tooltipText={`The configured Sourcify server (${chainSettings.verifiers['Sourcify'].apiUrl}) does not support chain ${selectedChain?.chainId}`}>
                    <span className="text-secondary w-auto" style={{ textDecoration: 'underline dotted', cursor: 'pointer' }} onClick={() => navigate('/settings')}>
                      Unsupported
                    </span>
                  </CustomTooltip>
                ) : (
                  <span className="text-secondary">{chainSettings.verifiers[verifierId].apiUrl}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <button type="submit" className="btn btn-primary mt-3" disabled={submitDisabled}>
        Verify
      </button>
    </form>
  )
}